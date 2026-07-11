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
 * - `listPending` — admin-only, org-scoped.
 * - `provisionFromRequest` — admin-only. Provisions the hosted mailbox straight
 *   from the request through the shared provisioning path and marks it
 *   `fulfilled` (the requester is admitted to their inbox). Idempotent.
 * - `resolve` — admin-only. Plain acknowledge/decline for the cases where no
 *   hosted mailbox is provisioned here (external account, or handled elsewhere).
 */

import { v } from 'convex/values';
import { authedMutation, authedQuery } from '../lib/authedFunctions';
import {
	getBetterAuthSessionWithRole,
	requireAdminContext,
	requireAuthenticatedIdentity,
	requireOrgPermission,
} from '../lib/sessionOrganization';
import { getOrThrow, throwForbidden, throwInvalidInput, throwInvalidState } from '../_utils/errors';
import { normalizeEmail } from '@owlat/shared';
import { markOnboardingStep } from '../auth/userOnboarding';
import {
	canonicalAddress,
	createProvisionedMailbox,
	getActiveMailboxForUser,
	isDomainVerified,
} from './mailbox';
import { claimReservedMailbox } from './pendingMailbox';
import type { Id } from '../_generated/dataModel';

/** Max length of the free-text note a member can attach to a mailbox request. */
const MAX_NOTE_LENGTH = 500;

/**
 * Derive a hosted local-part from the requester's (usually external) login
 * email: take the part before `@`, lowercase it, and drop anything outside the
 * mailbox local-part charset so the result is a valid `localpart@<domain>`
 * (mirrors `pendingMailbox`'s `LOCALPART_PATTERN`). Returns '' when nothing
 * usable remains — the caller refuses rather than build a bad address.
 */
function localpartFromEmail(email: string): string {
	const local = normalizeEmail(email).split('@')[0] ?? '';
	return local.replace(/[^a-z0-9._-]/g, '');
}

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

		// Nothing to request if the caller already has a live mailbox. Use the same
		// active-only predicate the dead-end guard (`freshStartStatus`) uses, so the
		// member who most needs the escape hatch — one whose only mailbox is
		// suspended/deleted — is never refused.
		const existingMailbox = await getActiveMailboxForUser(ctx, session.userId);
		if (existingMailbox) {
			throwInvalidState('You already have a mailbox');
		}

		if (args.note !== undefined && args.note.length > MAX_NOTE_LENGTH) {
			throwInvalidInput(`Note must be ${MAX_NOTE_LENGTH} characters or fewer`);
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

		// The admin card is only useful if it names who is asking. Prefer the
		// profile email, but fall back to the session identity's email rather than
		// inserting a blank identity that renders as an empty card.
		let requesterEmail = profile?.email?.trim();
		if (!requesterEmail) {
			const identity = await requireAuthenticatedIdentity(ctx);
			requesterEmail = typeof identity.email === 'string' ? identity.email.trim() : '';
		}
		if (!requesterEmail) {
			throwInvalidState('Your account has no email address to share with admins');
		}

		const requestId = await ctx.db.insert('mailboxRequests', {
			authUserId: session.userId,
			organizationId: session.activeOrganizationId,
			requesterEmail,
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
 *   - `reservationAwaitingDomain` — the reservation's sending domain hasn't
 *     verified yet (an early-instance invite). The mailbox can't be stood up
 *     until it does, so the guard shows "reserved, activates when your domain
 *     verifies" progress rather than "being set up right now".
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
		reservationAwaitingDomain: boolean;
		hasOpenRequest: boolean;
	}> => {
		const session = await getBetterAuthSessionWithRole(ctx);
		if (!session) {
			return {
				hasMailbox: false,
				reservedAddress: null,
				reservationAwaitingDomain: false,
				hasOpenRequest: false,
			};
		}

		const mailbox = await getActiveMailboxForUser(ctx, session.userId);
		if (mailbox) {
			return {
				hasMailbox: true,
				reservedAddress: null,
				reservationAwaitingDomain: false,
				hasOpenRequest: false,
			};
		}

		const profile = await ctx.db
			.query('userProfiles')
			.withIndex('by_auth_user_id', (q) => q.eq('authUserId', session.userId))
			.first();
		const email = profile?.email ? normalizeEmail(profile.email) : undefined;

		let reservedAddress: string | null = null;
		let reservationAwaitingDomain = false;
		if (email) {
			const pending = await ctx.db
				.query('pendingMailboxes')
				.withIndex('by_invitee_email', (q) => q.eq('inviteeEmail', email))
				.first();
			reservedAddress = pending?.address ?? null;
			if (pending) {
				reservationAwaitingDomain = !(await isDomainVerified(ctx, pending.domain));
			}
		}

		const open = await ctx.db
			.query('mailboxRequests')
			.withIndex('by_auth_user_id', (q) => q.eq('authUserId', session.userId))
			.filter((q) => q.eq(q.field('status'), 'open'))
			.first();

		return {
			hasMailbox: false,
			reservedAddress,
			reservationAwaitingDomain,
			hasOpenRequest: Boolean(open),
		};
	},
});

/** Admin-only: the open mailbox requests for the caller's organization. */
// authz: admin — requireOrgPermission('organization:manage') gates the read.
export const listPending = authedQuery({
	args: {},
	handler: async (ctx) => {
		await requireOrgPermission(ctx, 'organization:manage');
		const session = await getBetterAuthSessionWithRole(ctx);
		if (!session?.activeOrganizationId) return [];

		const rows = await ctx.db
			.query('mailboxRequests')
			.withIndex('by_org_and_status', (q) =>
				q.eq('organizationId', session.activeOrganizationId!).eq('status', 'open')
			)
			.collect();
		// bounded: open requests per org are bounded by member count (one open row
		// per member, refreshed not stacked), and the org is single-tenant.

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
 * Admin-only: provision the hosted mailbox straight from the request and mark it
 * `fulfilled` — closing the loop instead of leaving a plain acknowledgement.
 *
 * The mailbox is stood up through the SAME shared provisioning path the admin
 * members flow uses (`createProvisionedMailbox` / `claimReservedMailbox`): the
 * admin scope is never bypassed and the reservation/claim machinery is honoured
 * — if a hosted mailbox was already reserved for the requester (via an
 * invitation), we provision THAT reserved address and consume the reservation
 * rather than orphaning it. Otherwise a fresh mailbox is stood up at
 * `localpart@<verified sending domain>` — NEVER at the requester's external
 * login address (that domain's MX doesn't point here, so the inbox could never
 * receive mail; principle #5, honesty). A verified sending domain is required —
 * the UI disable is an affordance, this is the fence.
 *
 * The requester is notified in-app: their onboarding flips to mailbox-ready and
 * their fresh-start guard now admits them to the inbox.
 *
 * Move-linked requests (raised by `mailboxMove.start` for a non-admin mover) are
 * NOT provisioned here — they belong to the move state machine
 * (`mailboxMove.provisionHosted`, which bypasses the address dup-check and
 * advances the move). Provisioning them here would strand the move, so we refuse
 * with a pointer to the move card.
 *
 * Idempotent / redelivery-safe: a second call on an already-fulfilled request
 * returns the same mailbox, and a request whose requester already has a live
 * HOSTED mailbox is fulfilled against that mailbox instead of standing up a
 * second one.
 */
// authz: admin — requireAdminContext gates hosted-mailbox provisioning.
export const provisionFromRequest = authedMutation({
	args: {
		requestId: v.id('mailboxRequests'),
	},
	handler: async (ctx, args) => {
		await requireAdminContext(ctx);
		const session = await getBetterAuthSessionWithRole(ctx);
		if (!session?.activeOrganizationId) throwForbidden('No active organization');
		const organizationId = session.activeOrganizationId;

		const row = await getOrThrow(ctx, args.requestId, 'Request');
		if (row.organizationId !== organizationId) {
			throwForbidden('Request not accessible');
		}

		const now = Date.now();

		// Idempotent: already fulfilled → return the mailbox we stood up.
		if (row.status === 'fulfilled' && row.fulfilledMailboxId != null) {
			return { fulfilled: true as const, mailboxId: row.fulfilledMailboxId };
		}

		// The fulfil stamp: mark the row fulfilled (audit-stamped) and notify the
		// requester in-app — onboarding flips to mailbox-ready and their fresh-start
		// guard (freshStartStatus) now admits them to the inbox.
		const fulfil = async (mailboxId: Id<'mailboxes'>) => {
			await ctx.db.patch(row._id, {
				status: 'fulfilled',
				fulfilledMailboxId: mailboxId,
				resolvedByUserId: session.userId,
				resolvedAt: now,
			});
			await markOnboardingStep(ctx, row.authUserId, 'mailboxReady');
			return { fulfilled: true as const, mailboxId };
		};

		// Move-linked request: `mailboxMove.start` raises a request for a non-admin
		// mover whose external mailbox stays live throughout the move. Its lifecycle
		// belongs to the move (mailboxMove.provisionHosted advances the move AND
		// resolves the request); fulfilling it here would strand the move at
		// `provisioning`. Point the admin at the move card instead.
		const linkedMove = await ctx.db
			.query('mailboxMoves')
			.withIndex('by_user', (q) => q.eq('userId', row.authUserId))
			.filter((q) => q.eq(q.field('provisionRequestId'), args.requestId))
			.first();
		if (linkedMove) {
			throwInvalidState(
				'This request is part of a mailbox move — provision it from the move instead.'
			);
		}

		// Redelivery-safe: the requester may already have a live HOSTED mailbox
		// (claimed a reservation, or a concurrent provision won). Fulfil against it
		// rather than standing up a second one. Only a hosted mailbox counts — an
		// external/connected mailbox is not what this request asks for (and a mover's
		// external mailbox must never be mistaken for a fulfilled hosted one).
		const existingHosted = await ctx.db
			.query('mailboxes')
			.withIndex('by_user', (q) => q.eq('userId', row.authUserId))
			.filter((q) => q.eq(q.field('status'), 'active'))
			.filter((q) => q.neq(q.field('kind'), 'external'))
			.first();
		if (existingHosted) {
			return fulfil(existingHosted._id);
		}

		// Honour the reservation/claim machinery: if a hosted mailbox was already
		// reserved for this requester (an invitation set one up) IN THIS ORG,
		// provision THAT reserved address and consume the reservation — never orphan
		// it by standing up a mailbox at a different address. Scope the lookup to the
		// caller's org so a foreign-org reservation first in the index can't shadow
		// a same-org one.
		const reserved = await ctx.db
			.query('pendingMailboxes')
			.withIndex('by_invitee_email', (q) =>
				q.eq('inviteeEmail', normalizeEmail(row.requesterEmail))
			)
			.filter((q) => q.eq(q.field('organizationId'), organizationId))
			.first();

		if (reserved) {
			const claim = await claimReservedMailbox(ctx, reserved, row.authUserId);
			if (!claim.ok) {
				if (claim.reason === 'domain_unverified') {
					throwInvalidState(
						`Verify the sending domain ${reserved.domain} before provisioning ${reserved.address}.`
					);
				}
				throwInvalidState(`A mailbox already exists at ${reserved.address}`);
			}
			return fulfil(claim.mailboxId);
		}

		// No reservation: stand up a fresh hosted mailbox. Hosted mail requires a
		// verified sending domain — the mailbox must live on a domain this
		// deployment actually hosts, or inbound mail can never arrive and marking
		// the request fulfilled would be a lie (principle #5). Build the address as
		// `localpart@<verified domain>` (mirroring the reservation / add-mailbox
		// shape), never at the requester's external login address.
		const verifiedDomain = await ctx.db
			.query('domains')
			.withIndex('by_status', (q) => q.eq('status', 'verified'))
			.first();
		if (!verifiedDomain) {
			throwInvalidState('Verify a sending domain before provisioning a hosted mailbox.');
		}

		const localpart = localpartFromEmail(row.requesterEmail);
		if (!localpart) {
			throwInvalidState('This requester has no usable mailbox name — provision one manually.');
		}

		const mailboxId = await createProvisionedMailbox(ctx, {
			userId: row.authUserId,
			organizationId,
			address: canonicalAddress(`${localpart}@${verifiedDomain.domain}`),
		});

		return fulfil(mailboxId);
	},
});

/**
 * Admin-only: mark a request resolved WITHOUT provisioning here — the plain
 * acknowledge/decline path (the requester connects an external account instead,
 * or the admin handled it some other way). Org-scoped — a request from another
 * org is rejected.
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

		const row = await getOrThrow(ctx, args.requestId, 'Request');
		if (row.organizationId !== session.activeOrganizationId) {
			throwForbidden('Request not accessible');
		}

		// Idempotent, and never downgrade a decided row: a stale 'Mark done' racing
		// another admin's 'Provision now' must not turn `fulfilled` back into
		// `resolved` and erase the fulfilment distinction. Only open rows resolve.
		if (row.status !== 'open') {
			return { resolved: true as const };
		}

		await ctx.db.patch(args.requestId, {
			status: 'resolved',
			resolvedByUserId: session.userId,
			resolvedAt: Date.now(),
		});
		return { resolved: true as const };
	},
});
