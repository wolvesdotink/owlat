/**
 * Mailbox requests — the honest dead-end of the fresh-start flow.
 *
 * When a new member finishes onboarding with no mailbox they can reach (no
 * reserved hosted mailbox AND external-account connection is disabled), there
 * is nothing productive for them to do until an admin acts. Rather than a mute
 * "no mailbox configured" wall, they send ONE in-app request; admins see the
 * open requests on the dashboard and set a mailbox up.
 *
 * - `request` — authed self. Idempotent: reuses the member's existing open row
 *   instead of stacking duplicates. Refused once the member already has a
 *   mailbox (nothing to ask for).
 * - `listPending` / `resolve` — admin-only, org-scoped.
 */

import { v } from 'convex/values';
import { authedMutation, authedQuery } from '../lib/authedFunctions';
import { getBetterAuthSessionWithRole, requireAdminContext } from '../lib/sessionOrganization';
import { throwForbidden, throwInvalidState, throwNotFound } from '../_utils/errors';

/**
 * Ask an admin to set up a mailbox. Self-authed; reuses the caller's open
 * request if one already exists (idempotent) and refuses if the caller already
 * owns a mailbox — there is nothing to request.
 */
// authz: self — writes only the caller's own request row.
export const request = authedMutation({
	args: {
		note: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const session = await getBetterAuthSessionWithRole(ctx);
		if (!session) throwForbidden('Not signed in');
		if (!session.activeOrganizationId) throwForbidden('No active organization');

		// Nothing to request if the caller already has a live mailbox.
		const existingMailbox = await ctx.db
			.query('mailboxes')
			.withIndex('by_user', (q) => q.eq('userId', session.userId))
			.first();
		if (existingMailbox) {
			throwInvalidState('You already have a mailbox');
		}

		const note = args.note?.trim() || undefined;

		// One open request per member: refresh the note instead of stacking.
		const open = await ctx.db
			.query('mailboxRequests')
			.withIndex('by_auth_user_id', (q) => q.eq('authUserId', session.userId))
			.filter((q) => q.eq(q.field('status'), 'open'))
			.first();
		if (open) {
			await ctx.db.patch(open._id, { note });
			return { requested: true as const, requestId: open._id };
		}

		const profile = await ctx.db
			.query('userProfiles')
			.withIndex('by_auth_user_id', (q) => q.eq('authUserId', session.userId))
			.first();

		const requestId = await ctx.db.insert('mailboxRequests', {
			authUserId: session.userId,
			organizationId: session.activeOrganizationId,
			requesterEmail: profile?.email ?? '',
			requesterName: profile?.name,
			note,
			status: 'open',
			createdAt: Date.now(),
		});
		return { requested: true as const, requestId };
	},
});

/**
 * Self-authed read the fresh-start welcome and the Postbox mailbox guard use to
 * decide what the member can actually do:
 *   - `hasMailbox`    — a live personal mailbox already exists → land in Postbox.
 *   - `reservedAddress` — a hosted mailbox is reserved for their email but not
 *     yet claimed → offer to claim it.
 *   - `hasOpenRequest` — they have already asked an admin (don't offer twice).
 * The "can they connect an external account" leg is a feature flag the client
 * already resolves, so it stays out of this read.
 */
// authz: self — reads only the caller's own mailbox / reservation / request rows.
export const freshStartStatus = authedQuery({
	args: {},
	handler: async (
		ctx
	): Promise<{
		hasMailbox: boolean;
		reservedAddress: string | null;
		hasOpenRequest: boolean;
	}> => {
		const session = await getBetterAuthSessionWithRole(ctx);
		if (!session) {
			return { hasMailbox: false, reservedAddress: null, hasOpenRequest: false };
		}

		const mailbox = await ctx.db
			.query('mailboxes')
			.withIndex('by_user', (q) => q.eq('userId', session.userId))
			.filter((q) => q.eq(q.field('status'), 'active'))
			.first();
		if (mailbox) {
			return { hasMailbox: true, reservedAddress: null, hasOpenRequest: false };
		}

		const profile = await ctx.db
			.query('userProfiles')
			.withIndex('by_auth_user_id', (q) => q.eq('authUserId', session.userId))
			.first();
		const email = profile?.email?.trim().toLowerCase();

		let reservedAddress: string | null = null;
		if (email) {
			const pending = await ctx.db
				.query('pendingMailboxes')
				.withIndex('by_invitee_email', (q) => q.eq('inviteeEmail', email))
				.first();
			reservedAddress = pending?.address ?? null;
		}

		const open = await ctx.db
			.query('mailboxRequests')
			.withIndex('by_auth_user_id', (q) => q.eq('authUserId', session.userId))
			.filter((q) => q.eq(q.field('status'), 'open'))
			.first();

		return { hasMailbox: false, reservedAddress, hasOpenRequest: Boolean(open) };
	},
});

/** Admin-only: the open mailbox requests for the caller's organization. */
// authz: admin — requireAdminContext gates the whole handler.
export const listPending = authedQuery({
	args: {},
	handler: async (ctx) => {
		await requireAdminContext(ctx);
		const session = await getBetterAuthSessionWithRole(ctx);
		if (!session?.activeOrganizationId) return [];

		const rows = await ctx.db
			.query('mailboxRequests')
			.withIndex('by_org_and_status', (q) =>
				q.eq('organizationId', session.activeOrganizationId!).eq('status', 'open')
			)
			.collect();

		return rows.map((r) => ({
			id: r._id,
			email: r.requesterEmail,
			name: r.requesterName ?? null,
			note: r.note ?? null,
			createdAt: r.createdAt,
		}));
	},
});

/**
 * Admin-only: mark a request resolved (the admin has provisioned a mailbox or
 * decided otherwise). Org-scoped — a request from another org is rejected.
 */
// authz: admin — requireAdminContext gates the whole handler.
export const resolve = authedMutation({
	args: {
		requestId: v.id('mailboxRequests'),
	},
	handler: async (ctx, args) => {
		await requireAdminContext(ctx);
		const session = await getBetterAuthSessionWithRole(ctx);
		if (!session?.activeOrganizationId) throwForbidden('No active organization');

		const row = await ctx.db.get(args.requestId);
		if (!row) throwNotFound('Request');
		if (row.organizationId !== session.activeOrganizationId) {
			throwForbidden('Request not accessible');
		}

		await ctx.db.patch(args.requestId, {
			status: 'resolved',
			resolvedByUserId: session.userId,
			resolvedAt: Date.now(),
		});
		return { resolved: true as const };
	},
});
