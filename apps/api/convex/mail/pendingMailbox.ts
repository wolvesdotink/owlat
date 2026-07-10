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
import { authedMutation } from '../lib/authedFunctions';
import { markOnboardingStep } from '../auth/userOnboarding';
import { requireAdminContext, getBetterAuthSessionWithRole } from '../lib/sessionOrganization';
import {
	throwForbidden,
	throwUnauthenticated,
	throwInvalidInput,
	throwInvalidState,
	throwAlreadyExists,
} from '../_utils/errors';
import { canonicalAddress, provisionMailbox } from './mailbox';

const LOCALPART_PATTERN = /^[a-z0-9._-]+$/;

function normalizeLocalpart(raw: string): string {
	return raw.trim().toLowerCase();
}

function normalizeDomain(raw: string): string {
	return raw.trim().toLowerCase();
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

		const domainRow = await ctx.db
			.query('domains')
			.withIndex('by_domain', (q) => q.eq('domain', domain))
			.first();
		if (!domainRow || domainRow.status !== 'verified') {
			throwInvalidState(`Domain ${domain} is not a verified domain`);
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

		const liveCollision = await ctx.db
			.query('mailboxes')
			.withIndex('by_address', (q) => q.eq('address', pending.address))
			.first();
		if (liveCollision) {
			await ctx.db.delete(pending._id);
			return { created: false as const, error: 'address_taken' as const };
		}

		const mailboxId = await provisionMailbox(ctx, {
			userId: session.userId,
			organizationId: pending.organizationId,
			address: pending.address,
			domain: pending.domain,
			displayName: pending.displayName,
		});

		await ctx.db.delete(pending._id);

		await markOnboardingStep(ctx, session.userId, 'mailboxReady');

		return {
			created: true as const,
			mailboxId,
			address: pending.address,
		};
	},
});
