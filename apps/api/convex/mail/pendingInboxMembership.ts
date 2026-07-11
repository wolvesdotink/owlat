/**
 * Team-inbox membership grants — the shared-inbox analogue of the mailbox
 * reservations in `mail/pendingMailbox.ts`. Adding a not-yet-member email to a
 * team inbox reserves a grant here (and the caller separately issues the org
 * invite); the grant is claimed into a real `mailboxMembers` row when that
 * person accepts.
 *
 * Split out from `mail/pendingMailbox.ts`: the two intent layers touch different
 * tables (`pendingMailboxMembers` vs `pendingMailboxes`) and share no logic, so
 * they live in sibling files per the CONVENTIONS "split above ~500 LOC" rule.
 */

import { v } from 'convex/values';
import { internalQuery } from '../_generated/server';
import { authedMutation, adminMutation } from '../lib/authedFunctions';
import { getBetterAuthSessionWithRole } from '../lib/sessionOrganization';
import { normalizeEmail, isValidEmail } from '../lib/inputGuards';
import { throwForbidden, throwUnauthenticated, throwInvalidInput } from '../_utils/errors';
import { requireMailboxAccess } from './permissions';

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
