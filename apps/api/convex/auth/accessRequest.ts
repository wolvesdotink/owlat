/**
 * Access requests — the door out of the "invitation required" dead-end.
 *
 * Owlat is invite-only: a user can authenticate (any configured sign-in method)
 * yet belong to no organization. The setup/team page used to meet that user with
 * a mute "Invitation required — ask your administrator" wall whose only action
 * was to sign out. That is a dead-end: the user has no in-app way to actually
 * reach an admin.
 *
 * This module lets the orgless-but-signed-in user ASK for access in one click.
 * The request is a NOTIFICATION, never a grant:
 *   - `request` — authed-identity self. Inserts one open row (idempotent: reuses
 *     the caller's existing open row instead of stacking) addressed to the single
 *     deployment org. It NEVER writes the BetterAuth member table, so it cannot
 *     add the caller to the org — an admin still invites them the normal way.
 *   - `listPending` / `resolve` — admin-only. Admins see open requests on the
 *     dashboard (reusing the mailbox-request surfacing pattern) and mark a row
 *     done once they've invited the person.
 *
 * Single-org-per-deployment stays intact: there is no self-serve org creation
 * here, only a message to the one org's admins.
 */

import { v } from 'convex/values';
import { adminMutation, adminQuery, authedIdentityMutation } from '../lib/authedFunctions';
import {
	getBetterAuthSession,
	getBetterAuthSessionWithRole,
	getSingletonOrganizationId,
	requireAuthenticatedIdentity,
} from '../lib/sessionOrganization';
import {
	throwForbidden,
	throwInvalidInput,
	throwInvalidState,
	throwNotFound,
} from '../_utils/errors';

/** Max length of the free-text note a requester can attach. */
const MAX_NOTE_LENGTH = 500;

/**
 * Ask an admin for access to this instance. Self-authed via the identity floor
 * (the caller is signed in but not yet an org member, so the org-member floor
 * would reject them). Idempotent: reuses the caller's open request if one exists
 * and refuses if the caller already belongs to the org — there is nothing to ask
 * for. Crucially it never touches the member table, so it cannot self-grant
 * membership; it only records the ask for admins to see.
 */
// authz: self — signed-in identity, writes only the caller's own request row.
// Never grants org membership (no member-table write anywhere in this handler).
export const request = authedIdentityMutation({
	args: {
		note: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const identity = await requireAuthenticatedIdentity(ctx);
		const userId = identity.subject;

		// Already in the org? There is nothing to request. An orgless user's
		// session has no active org; a member's does, so this is the honest gate.
		const session = await getBetterAuthSession(ctx);
		if (session?.activeOrganizationId) {
			throwInvalidState('You already have access to this workspace');
		}

		if (args.note !== undefined && args.note.length > MAX_NOTE_LENGTH) {
			throwInvalidInput(`Note must be ${MAX_NOTE_LENGTH} characters or fewer`);
		}
		const note = args.note?.trim() || undefined;

		// One open request per user: refresh the note instead of stacking.
		const open = await ctx.db
			.query('accessRequests')
			.withIndex('by_auth_user_id', (q) => q.eq('authUserId', userId))
			.filter((q) => q.eq(q.field('status'), 'open'))
			.first();
		if (open) {
			await ctx.db.patch(open._id, { note });
			return { requested: true as const, requestId: open._id };
		}

		// The admin card is only useful if it names who is asking. Prefer the
		// profile email (written at signup), fall back to the session identity's
		// email rather than inserting a blank row that renders as an empty card.
		const profile = await ctx.db
			.query('userProfiles')
			.withIndex('by_auth_user_id', (q) => q.eq('authUserId', userId))
			.first();
		let requesterEmail = profile?.email?.trim();
		if (!requesterEmail) {
			requesterEmail = typeof identity.email === 'string' ? identity.email.trim() : '';
		}
		if (!requesterEmail) {
			throwInvalidState('Your account has no email address to share with admins');
		}

		// The one deployment org the request is addressed to. Resolved directly
		// (not via the session) because the caller has no active org.
		const organizationId = await getSingletonOrganizationId(ctx);

		const requestId = await ctx.db.insert('accessRequests', {
			authUserId: userId,
			organizationId,
			requesterEmail,
			requesterName: profile?.name,
			note,
			status: 'open',
			createdAt: Date.now(),
		});
		return { requested: true as const, requestId };
	},
});

/** Admin-only: the open access requests for this deployment's organization. */
// authz: admin — adminQuery gates the read on `organization:manage`.
export const listPending = adminQuery({
	args: {},
	handler: async (ctx) => {
		const session = await getBetterAuthSessionWithRole(ctx);
		if (!session?.activeOrganizationId) return [];

		const rows = await ctx.db
			.query('accessRequests')
			.withIndex('by_org_and_status', (q) =>
				q.eq('organizationId', session.activeOrganizationId!).eq('status', 'open')
			)
			.collect();
		// bounded: open requests are one row per orgless requester, refreshed not
		// stacked, and this deployment hosts a single organization.

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
 * Admin-only: mark a request resolved (the admin has invited the person or
 * decided otherwise). Org-scoped — a request from another org is rejected.
 * Resolving is a plain acknowledgement; it does NOT invite the user (that stays
 * an explicit action in the members flow).
 */
// authz: admin — adminMutation gates the whole handler on `organization:manage`.
export const resolve = adminMutation({
	args: {
		requestId: v.id('accessRequests'),
	},
	handler: async (ctx, args) => {
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
