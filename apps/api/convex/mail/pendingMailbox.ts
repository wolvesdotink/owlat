/**
 * Pending-mailbox reservations attached to BetterAuth invitations.
 *
 * Admins can reserve `localpart@verifiedDomain` for an invitee at
 * invite time; the row is consumed (mailbox actually provisioned)
 * when the invitee accepts and we finally have their `userId`.
 *
 * Live mailbox CRUD stays in `mail/mailbox.ts`; this file only owns
 * the intent layer.
 */

import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import type { MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { authedMutation } from '../lib/authedFunctions';
import { markOnboardingStep } from '../auth/userOnboarding';
import { requireAdminContext, getBetterAuthSessionWithRole } from '../lib/sessionOrganization';
import { normalizeEmail } from '../lib/inputGuards';
import {
	throwForbidden,
	throwUnauthenticated,
	throwInvalidInput,
	throwInvalidState,
	throwAlreadyExists,
} from '../_utils/errors';
import { canonicalAddress, provisionMailbox, isDomainVerified } from './mailbox';

// Upper bound on the reservations swept per domain in one verify/remove pass.
// A brand-new instance carries at most a handful of pre-verification
// reservations on any single domain, so this is comfortably above the real
// ceiling while keeping the sweep O(cap) instead of an unbounded .collect().
const RESERVATION_SWEEP_CAP = 200;

const LOCALPART_PATTERN = /^[a-z0-9._-]+$/;

/**
 * Consume a pending reservation into a live mailbox for `userId` — the shared
 * claim shape behind both the invitee self-claim (`claimForInvitation`) and the
 * admin provision-from-request path (`mail.mailboxRequest.provisionFromRequest`)
 * so the collision guard and the provision → delete-reservation → mark-ready
 * sequence can never drift between them.
 *
 * Fails without provisioning when:
 *   - `'domain_unverified'` — the reserved domain is not verified yet (a
 *     pre-verification reservation on a brand-new instance). The reservation is
 *     left in place so it can materialize once the domain verifies; the invitee
 *     sees "reserved, activates when your domain verifies" progress meanwhile.
 *   - `'address_taken'` — a live mailbox already holds the reserved address. The
 *     reservation is left in place; the caller decides whether to clear it.
 *
 * On success it provisions the mailbox at the reserved address, deletes the
 * reservation, marks the user's onboarding mailbox-ready, and returns the id.
 */
export type ClaimReservedResult =
	| { ok: true; mailboxId: Id<'mailboxes'> }
	| { ok: false; reason: 'domain_unverified' | 'address_taken' };

export async function claimReservedMailbox(
	ctx: MutationCtx,
	pending: Doc<'pendingMailboxes'>,
	userId: string
): Promise<ClaimReservedResult> {
	// A hosted mailbox must live on a VERIFIED sending domain — the reservation
	// may have been made pre-verification (early-instance invite). Never stand up
	// a mailbox on an unverified domain: inbound mail could not arrive, so it
	// would be a dishonest "your mailbox is ready".
	if (!(await isDomainVerified(ctx, pending.domain))) {
		return { ok: false as const, reason: 'domain_unverified' as const };
	}

	const liveCollision = await ctx.db
		.query('mailboxes')
		.withIndex('by_address', (q) => q.eq('address', pending.address))
		.first();
	if (liveCollision) {
		return { ok: false as const, reason: 'address_taken' as const };
	}

	const mailboxId = await provisionMailbox(ctx, {
		userId,
		organizationId: pending.organizationId,
		address: pending.address,
		domain: pending.domain,
		displayName: pending.displayName,
	});

	await ctx.db.delete(pending._id);
	await markOnboardingStep(ctx, userId, 'mailboxReady');

	return { ok: true as const, mailboxId };
}

/**
 * Verify-time sweep: when a sending domain finally verifies, provision the
 * mailboxes that were reserved on it for invitees who have ALREADY accepted (so
 * they were parked in the "reserved, activates when your domain verifies" state).
 * Scheduled off the `→ verified` edge from `domains/lifecycle.ts`.
 *
 * "Already accepted" is read from `acceptedByUserId`, stamped by
 * `claimForInvitation` at accept time — NOT re-derived by matching the invitee
 * email against `userProfiles`. That distinction is load-bearing: a person who
 * registered via the invite link but never accepted (register.vue creates the
 * profile before the accept step), or any pre-existing account with that email,
 * must NOT silently receive a live org mailbox; and because profile emails are
 * stored as typed (mixed case) while the reservation email is canonical
 * lowercase, an email match would also miss legitimately-parked invitees. Using
 * the recorded userId sidesteps both.
 *
 * Reservations with no `acceptedByUserId` are left untouched — they materialize
 * through the normal accept-time claim (`claimForInvitation`), which now
 * succeeds because the domain is verified. Bounded per domain (a handful of
 * reservations on a brand-new instance). Returns how many mailboxes it stood up.
 */
export async function claimReservationsForVerifiedDomain(
	ctx: MutationCtx,
	domain: string
): Promise<number> {
	const normalized = normalizeEmail(domain);
	const reservations = await ctx.db
		.query('pendingMailboxes')
		.withIndex('by_domain', (q) => q.eq('domain', normalized))
		.take(RESERVATION_SWEEP_CAP);

	let provisioned = 0;
	for (const pending of reservations) {
		// Only invitees who ACCEPTED (and were parked here) can be provisioned now,
		// using the exact userId recorded at accept time.
		const acceptedByUserId = pending.acceptedByUserId;
		if (acceptedByUserId === undefined) {
			continue;
		}

		const claim = await claimReservedMailbox(ctx, pending, acceptedByUserId);
		if (claim.ok) {
			provisioned += 1;
		}
	}
	return provisioned;
}

/**
 * Scheduled wrapper for the verify-time sweep. `domains/lifecycle.ts` schedules
 * this via `ctx.scheduler.runAfter(0, …)` on the `→ verified` edge — decoupled
 * from the domain transition itself so a provisioning throw here can never roll
 * back the domain's move to `verified` (mirrors how `register_with_provider` /
 * `delete_with_provider` are scheduled rather than run inline).
 */
export const provisionReservationsForVerifiedDomain = internalMutation({
	args: { domain: v.string() },
	handler: async (ctx, args) => {
		await claimReservationsForVerifiedDomain(ctx, args.domain);
	},
});

/**
 * Drop every reservation on `domain`. Called from the domain remove/delete
 * lifecycle path: a removed (or failed-and-cleared) domain will never verify, so
 * its reservations would otherwise strand invitees on "activates when your
 * domain verifies" forever and keep the rows alive indefinitely. Mirrors
 * `cancelForInvitation`. Bounded by `RESERVATION_SWEEP_CAP` per domain.
 */
export async function clearReservationsForDomain(
	ctx: MutationCtx,
	domain: string
): Promise<number> {
	const normalized = normalizeEmail(domain);
	const reservations = await ctx.db
		.query('pendingMailboxes')
		.withIndex('by_domain', (q) => q.eq('domain', normalized))
		.take(RESERVATION_SWEEP_CAP);
	for (const pending of reservations) {
		await ctx.db.delete(pending._id);
	}
	return reservations.length;
}

export const setForInvitation = authedMutation({
	args: {
		invitationId: v.string(),
		inviteeEmail: v.string(),
		localpart: v.string(),
		domain: v.string(),
		displayName: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		await requireAdminContext(ctx);
		const sessionWithOrg = await getBetterAuthSessionWithRole(ctx);
		if (!sessionWithOrg?.activeOrganizationId) {
			throwForbidden('No active organization');
		}

		const localpart = normalizeEmail(args.localpart);
		if (!LOCALPART_PATTERN.test(localpart)) {
			throwInvalidInput('Invalid local part. Use letters, digits, dots, hyphens, or underscores.');
		}
		const domain = normalizeEmail(args.domain);
		if (!domain) {
			throwInvalidInput('Domain is required');
		}

		// The domain must be one this instance actually hosts — verified OR still
		// registering/pending DNS. Reserving on a domain that isn't set up here at
		// all (or that failed verification) would be a spoof / a promise we can't
		// keep, so those are rejected. A reservation on a not-yet-verified domain is
		// intentional (early-instance invites): it materializes into a live mailbox
		// only once the domain verifies (see `claimReservedMailbox`).
		const domainRow = await ctx.db
			.query('domains')
			.withIndex('by_domain', (q) => q.eq('domain', domain))
			.first();
		if (!domainRow) {
			throwInvalidState(`Add ${domain} as a sending domain before reserving a mailbox on it.`);
		}
		if (domainRow.status === 'failed') {
			throwInvalidState(
				`Domain ${domain} failed verification — fix its DNS before reserving a mailbox on it.`
			);
		}

		const address = canonicalAddress(`${localpart}@${domain}`);

		const liveCollision = await ctx.db
			.query('mailboxes')
			.withIndex('by_address', (q) => q.eq('address', address))
			.first();
		if (liveCollision) {
			throwAlreadyExists(`Mailbox ${address} already exists`);
		}

		const pendingCollision = await ctx.db
			.query('pendingMailboxes')
			.withIndex('by_address', (q) => q.eq('address', address))
			.first();
		if (pendingCollision) {
			throwAlreadyExists(`Address ${address} is already reserved for another invite`);
		}

		const existingForInvite = await ctx.db
			.query('pendingMailboxes')
			.withIndex('by_invitation', (q) => q.eq('invitationId', args.invitationId))
			.first();
		if (existingForInvite) {
			await ctx.db.delete(existingForInvite._id);
		}

		const id = await ctx.db.insert('pendingMailboxes', {
			invitationId: args.invitationId,
			inviteeEmail: normalizeEmail(args.inviteeEmail),
			organizationId: sessionWithOrg.activeOrganizationId,
			localpart,
			domain,
			address,
			displayName: args.displayName,
			createdAt: Date.now(),
			createdByUserId: sessionWithOrg.userId,
		});

		return { id, address };
	},
});

export const cancelForInvitation = authedMutation({
	args: {
		invitationId: v.string(),
	},
	handler: async (ctx, args) => {
		await requireAdminContext(ctx);
		const existing = await ctx.db
			.query('pendingMailboxes')
			.withIndex('by_invitation', (q) => q.eq('invitationId', args.invitationId))
			.first();
		if (existing) {
			await ctx.db.delete(existing._id);
		}
		return { canceled: Boolean(existing) };
	},
});

// authz: scoped to the caller's active org (org-match check below); cross-org
// pending rows are rejected.
export const claimForInvitation = authedMutation({
	args: {
		invitationId: v.string(),
	},
	handler: async (ctx, args) => {
		const session = await getBetterAuthSessionWithRole(ctx);
		if (!session) {
			throwUnauthenticated();
		}
		if (!session.activeOrganizationId) {
			throwForbidden('No active organization');
		}

		const pending = await ctx.db
			.query('pendingMailboxes')
			.withIndex('by_invitation', (q) => q.eq('invitationId', args.invitationId))
			.first();
		if (!pending) {
			return { created: false as const };
		}

		if (pending.organizationId !== session.activeOrganizationId) {
			await ctx.db.delete(pending._id);
			return { created: false as const, error: 'organization_mismatch' as const };
		}

		// The claim is bound to the INVITED identity: any other org member who
		// learns the invitation id must not be able to take over the reserved
		// mailbox. The row is kept so the real invitee can still claim it.
		const profile = await ctx.db
			.query('userProfiles')
			.withIndex('by_auth_user_id', (q) => q.eq('authUserId', session.userId))
			.first();
		const callerEmail = profile?.email ? normalizeEmail(profile.email) : undefined;
		if (!callerEmail || callerEmail !== pending.inviteeEmail) {
			return { created: false as const, error: 'invitee_mismatch' as const };
		}

		const claim = await claimReservedMailbox(ctx, pending, session.userId);
		if (!claim.ok) {
			if (claim.reason === 'domain_unverified') {
				// Early-instance invite: the mailbox is reserved but its domain hasn't
				// verified yet. KEEP the reservation and STAMP it with the accepting
				// userId — the verify-time sweep provisions only stamped rows, using
				// this id, so acceptance + org-match + identity binding are recorded as
				// facts here rather than re-derived by email later. The invitee's
				// Postbox guard shows "reserved, activates when your domain verifies"
				// from `freshStartStatus`.
				await ctx.db.patch(pending._id, { acceptedByUserId: session.userId });
				return {
					created: false as const,
					error: 'awaiting_domain' as const,
					address: pending.address,
				};
			}
			// A live mailbox already holds the reserved address — the reservation is
			// stale, so clear it (the invitee will land in the fresh-start flow).
			await ctx.db.delete(pending._id);
			return { created: false as const, error: 'address_taken' as const };
		}

		return {
			created: true as const,
			mailboxId: claim.mailboxId,
			address: pending.address,
		};
	},
});
