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
import { internalQuery } from '../_generated/server';
import type { MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { authedMutation, adminMutation } from '../lib/authedFunctions';
import { markOnboardingStep } from '../auth/userOnboarding';
import { requireAdminContext, getBetterAuthSessionWithRole } from '../lib/sessionOrganization';
import { normalizeEmail, isValidEmail } from '../lib/inputGuards';
import {
	throwForbidden,
	throwUnauthenticated,
	throwInvalidInput,
	throwInvalidState,
	throwAlreadyExists,
} from '../_utils/errors';
import { canonicalAddress, provisionMailbox } from './mailbox';
import { requireMailboxAccess } from './permissions';

const LOCALPART_PATTERN = /^[a-z0-9._-]+$/;

function normalizeLocalpart(raw: string): string {
	return raw.trim().toLowerCase();
}

function normalizeDomain(raw: string): string {
	return raw.trim().toLowerCase();
}

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
	const domainRow = await ctx.db
		.query('domains')
		.withIndex('by_domain', (q) => q.eq('domain', pending.domain))
		.first();
	if (!domainRow || domainRow.status !== 'verified') {
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
 * Fired as a lifecycle effect from `domains/lifecycle.ts` on the `→ verified`
 * edge.
 *
 * Reservations whose invitee hasn't signed up yet are left untouched — they
 * materialize through the normal accept-time claim (`claimForInvitation`), which
 * now succeeds because the domain is verified. Bounded per domain (a handful of
 * reservations on a brand-new instance). Returns how many mailboxes it stood up.
 */
export async function claimReservationsForVerifiedDomain(
	ctx: MutationCtx,
	domain: string
): Promise<number> {
	const normalized = normalizeDomain(domain);
	const reservations = await ctx.db
		.query('pendingMailboxes')
		.withIndex('by_domain', (q) => q.eq('domain', normalized))
		.collect();

	let provisioned = 0;
	for (const pending of reservations) {
		// Only invitees who already have an account can be provisioned now; resolve
		// the account by the invite-bound email (the same identity claim binds to).
		const profile = await ctx.db
			.query('userProfiles')
			.withIndex('by_email', (q) => q.eq('email', pending.inviteeEmail))
			.first();
		if (!profile || profile.deletedAt !== undefined) {
			continue;
		}

		const claim = await claimReservedMailbox(ctx, pending, profile.authUserId);
		if (claim.ok) {
			provisioned += 1;
		}
	}
	return provisioned;
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

		const localpart = normalizeLocalpart(args.localpart);
		if (!LOCALPART_PATTERN.test(localpart)) {
			throwInvalidInput('Invalid local part. Use letters, digits, dots, hyphens, or underscores.');
		}
		const domain = normalizeDomain(args.domain);
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
			inviteeEmail: args.inviteeEmail.trim().toLowerCase(),
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
		const callerEmail = profile?.email?.trim().toLowerCase();
		if (!callerEmail || callerEmail !== pending.inviteeEmail) {
			return { created: false as const, error: 'invitee_mismatch' as const };
		}

		const claim = await claimReservedMailbox(ctx, pending, session.userId);
		if (!claim.ok) {
			if (claim.reason === 'domain_unverified') {
				// Early-instance invite: the mailbox is reserved but its domain hasn't
				// verified yet. KEEP the reservation — the verify-time sweep provisions
				// it the moment the domain goes live. The invitee's Postbox guard shows
				// "reserved, activates when your domain verifies" from `freshStartStatus`.
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

// ============================================================
// Team-inbox membership grants — the shared-inbox analogue of the reservation
// pattern above. Adding a not-yet-member email to a team inbox reserves a grant
// here (and the caller separately issues the org invite); the grant is claimed
// into a real `mailboxMembers` row when that person accepts.
// ============================================================

/**
 * Reserve a team-inbox membership for someone who is NOT yet an org member. The
 * caller issues the org invite (BetterAuth, the b1 flow); this row carries the
 * intent so the membership materializes on accept — and lets the invitation
 * email name the inbox (see `inboxInviteContextForEmail`). Existing org members
 * are added directly through `mailboxMembers.addMember`, not this path.
 *
 * Admin-gated (issuing an org invite requires admin) and owner-gated on the
 * mailbox itself. Idempotent per (org, email, mailbox): a repeat call returns
 * the existing reservation rather than stacking duplicates.
 */
export const reserveInboxMembership = adminMutation({
	args: {
		mailboxId: v.id('mailboxes'),
		inviteeEmail: v.string(),
	},
	handler: async (ctx, args) => {
		const access = await requireMailboxAccess(ctx, args.mailboxId, 'owner');
		if (!access.ok) {
			throwForbidden('You do not have permission to manage this inbox.');
		}
		if (access.mailbox.scope !== 'shared') {
			throwInvalidInput('You can only invite people to a team inbox.');
		}

		const inviteeEmail = normalizeEmail(args.inviteeEmail);
		if (!isValidEmail(inviteeEmail)) {
			throwInvalidInput('Enter a valid email address.');
		}

		// This path is only for people who aren't in the organization yet; an
		// existing member should be added from the members list (no invite, no
		// grant), and inviting them would fail at BetterAuth anyway.
		const existingProfile = await ctx.db
			.query('userProfiles')
			.withIndex('by_email', (q) => q.eq('email', inviteeEmail))
			.first();
		if (existingProfile && existingProfile.deletedAt === undefined) {
			throwInvalidInput('They are already in your organization — add them from the members list.');
		}

		// Idempotent per (org, email, mailbox): a repeat call is a no-op.
		const existing = await ctx.db
			.query('pendingMailboxMembers')
			.withIndex('by_org_email', (q) =>
				q.eq('organizationId', access.mailbox.organizationId).eq('inviteeEmail', inviteeEmail)
			)
			.collect(); // bounded: a person is pre-added to at most a handful of inboxes
		const already = existing.find((row) => row.mailboxId === args.mailboxId);
		if (already) {
			return { id: already._id, address: access.mailbox.address, alreadyReserved: true as const };
		}

		const id = await ctx.db.insert('pendingMailboxMembers', {
			organizationId: access.mailbox.organizationId,
			inviteeEmail,
			mailboxId: args.mailboxId,
			mailboxAddress: access.mailbox.address,
			invitedByUserId: access.userId,
			createdAt: Date.now(),
		});

		return { id, address: access.mailbox.address, alreadyReserved: false as const };
	},
});

/**
 * Claim every team-inbox membership reserved for the accepting user. Called
 * right after `acceptInvitation`, before the welcome redirect, so the inbox is
 * already in the sidebar when they land.
 *
 * The claim is bound to the caller's OWN login email (resolved from their
 * profile): a user can only materialize grants addressed to them, so knowing a
 * teammate's invite never grants their inbox access. Each grant becomes a
 * `member` row (idempotent — a second accept, or an already-present membership,
 * is a no-op) and the grant is deleted. Grants whose inbox no longer exists,
 * left the org, or stopped being shared are dropped without a membership.
 */
export const claimInboxMemberships = authedMutation({
	args: {},
	handler: async (ctx) => {
		// all-members: every member may claim, but ONLY grants bound to their own
		// login email — the email match below is the per-row authorization, so a
		// caller can never materialize a teammate's inbox access.
		const session = await getBetterAuthSessionWithRole(ctx);
		if (!session) {
			throwUnauthenticated();
		}
		if (!session.activeOrganizationId) {
			throwForbidden('No active organization');
		}
		const organizationId = session.activeOrganizationId;

		const profile = await ctx.db
			.query('userProfiles')
			.withIndex('by_auth_user_id', (q) => q.eq('authUserId', session.userId))
			.first();
		const callerEmail = profile?.email ? normalizeEmail(profile.email) : undefined;
		if (!callerEmail) {
			return { claimed: [] as string[] };
		}

		const grants = await ctx.db
			.query('pendingMailboxMembers')
			.withIndex('by_org_email', (q) =>
				q.eq('organizationId', organizationId).eq('inviteeEmail', callerEmail)
			)
			.collect(); // bounded: a person is pre-added to at most a handful of inboxes

		const claimed: string[] = [];
		for (const grant of grants) {
			// Drop grants whose target inbox is gone, moved org, or is no longer a
			// team inbox — nothing to grant, so just clear the stale row.
			const mailbox = await ctx.db.get(grant.mailboxId);
			if (
				!mailbox ||
				mailbox.status !== 'active' ||
				mailbox.scope !== 'shared' ||
				mailbox.organizationId !== organizationId
			) {
				await ctx.db.delete(grant._id);
				continue;
			}

			const existingMembership = await ctx.db
				.query('mailboxMembers')
				.withIndex('by_mailbox_user', (q) =>
					q.eq('mailboxId', grant.mailboxId).eq('authUserId', session.userId)
				)
				.unique();
			if (!existingMembership) {
				await ctx.db.insert('mailboxMembers', {
					mailboxId: grant.mailboxId,
					authUserId: session.userId,
					role: 'member',
					addedBy: grant.invitedByUserId,
					createdAt: Date.now(),
				});
			}
			await ctx.db.delete(grant._id);
			claimed.push(mailbox.address);
		}

		return { claimed };
	},
});

/**
 * Sweep every un-claimed team-inbox grant reserved for `inviteeEmail` in the
 * caller's active org. Called when an admin cancels the org invitation (grants
 * are keyed by email, not invitation id, so cancelling the invite must also
 * clear the pending membership — otherwise it would silently materialize inbox
 * access if that email ever joined later, contradicting the 7-day-expiry the
 * invitation email promises) and as best-effort rollback when reserving succeeds
 * but the invite send fails. Mirrors `cancelForInvitation` for `pendingMailboxes`.
 *
 * Admin-gated (the wrapper) and org-scoped: only grants in the caller's active
 * org are touched, so one org can never clear another's reservations.
 */
export const cancelInboxMembershipsForEmail = adminMutation({
	args: {
		inviteeEmail: v.string(),
		// When present, narrow the sweep to this one inbox's grant. The invite-cancel
		// path leaves it off (the whole invitation is gone, so every grant it carried
		// should go too); the reserve-failed-invite rollback passes it so it deletes
		// only the grant this attempt created, never a sibling inbox's live grant.
		mailboxId: v.optional(v.id('mailboxes')),
	},
	handler: async (ctx, args) => {
		const session = await getBetterAuthSessionWithRole(ctx);
		if (!session?.activeOrganizationId) {
			throwForbidden('No active organization');
		}
		const organizationId = session.activeOrganizationId;
		const inviteeEmail = normalizeEmail(args.inviteeEmail);
		if (!inviteeEmail) {
			return { canceled: 0 };
		}

		const grants = await ctx.db
			.query('pendingMailboxMembers')
			.withIndex('by_org_email', (q) =>
				q.eq('organizationId', organizationId).eq('inviteeEmail', inviteeEmail)
			)
			.collect(); // bounded: a person is pre-added to at most a handful of inboxes
		const targetMailboxId = args.mailboxId;
		const toCancel =
			targetMailboxId === undefined
				? grants
				: grants.filter((grant) => grant.mailboxId === targetMailboxId);
		for (const grant of toCancel) {
			await ctx.db.delete(grant._id);
		}
		return { canceled: toCancel.length };
	},
});

/**
 * Internal-only: the team inbox an invitee has been pre-added to, if any, so the
 * `sendInvitationEmail` hook can name it in the invitation ("<inviter> invited
 * you to <support@…>"). Returns the first reserved inbox address for
 * (org, email), or `null`. The grant is created before the invite is issued, so
 * it is already present when the hook fires.
 */
export const inboxInviteContextForEmail = internalQuery({
	args: {
		organizationId: v.string(),
		email: v.string(),
	},
	handler: async (ctx, args) => {
		const email = normalizeEmail(args.email);
		const grant = await ctx.db
			.query('pendingMailboxMembers')
			.withIndex('by_org_email', (q) =>
				q.eq('organizationId', args.organizationId).eq('inviteeEmail', email)
			)
			.first();
		return grant ? { inboxAddress: grant.mailboxAddress } : null;
	},
});
