/**
 * Team (shared) inbox creation + membership management.
 *
 * A shared inbox is a `mailboxes` row with `scope='shared'` whose access is
 * governed by explicit `mailboxMembers` rows — org membership alone grants
 * nothing (see the LOCKED decision 7 of the 2026-07-10 experience plan and the
 * access choke point in `mail/permissions.ts::requireMailboxAccess`).
 *
 * Surface:
 *   - createShared        admin-gated: provision a hosted team inbox, creator
 *                         becomes its owner, initial members are added.
 *   - listShared          admin-gated: every team inbox org-wide with its full
 *                         roster + pending invites — the Settings → Team
 *                         inboxes management surface.
 *   - members             list the roster (any member / org admin can read).
 *   - myRole              the caller's own role on a mailbox, or null — the
 *                         reactive query the UI (and tests) watch to see access
 *                         appear/disappear the instant membership changes.
 *   - addMember / removeMember / transferOwnership
 *                         mutate the roster; gated at the `owner` floor of
 *                         `requireMailboxAccess` (which also admits org
 *                         owner/admin), effective immediately via Convex
 *                         reactivity.
 *
 * Transport-agnostic: the same membership model governs a hosted team inbox and
 * an external (BYO IMAP) one — `requireMailboxAccess` never inspects `kind`.
 */

import { v } from 'convex/values';
import type { MutationCtx } from '../_generated/server';
import { adminQuery, authedMutation, authedQuery } from '../lib/authedFunctions';
import type { Id } from '../_generated/dataModel';
import { requireAdminContext, getBetterAuthSessionWithRole } from '../lib/sessionOrganization';
import { throwForbidden, throwInvalidInput } from '../_utils/errors';
import { requireMailboxAccess } from './permissions';
import { createProvisionedMailbox, canonicalAddress } from './mailbox';

/** Resolve a member's display fields from their `userProfiles` row. */
async function loadMemberProfile(
	ctx: Parameters<typeof getBetterAuthSessionWithRole>[0],
	authUserId: string
): Promise<{ name: string | null; email: string | null; image: string | null }> {
	const row = await ctx.db
		.query('userProfiles')
		.withIndex('by_auth_user_id', (q) => q.eq('authUserId', authUserId))
		.first();
	return {
		name: row?.name ?? null,
		email: row?.email ?? null,
		image: row?.image ?? null,
	};
}

/**
 * Assert `authUserId` is a live member of this deployment's organization — a
 * non-deleted `userProfiles` row exists for them (single-org-per-deployment, so
 * a profile row IS org membership; see project memory "Single Org Per
 * Deployment"). The write-side floor under the members picker: without it,
 * `createShared` / `addMember` / `transferOwnership` would accept an arbitrary
 * user-id string, and `transferOwnership` would point canonical ownership at a
 * nonexistent id — bricking the inbox for its owner. `requireMailboxAccess`
 * already blocks cross-org READS; this blocks bogus WRITES.
 */
async function assertOrgMemberUser(ctx: MutationCtx, authUserId: string): Promise<void> {
	const profile = await ctx.db
		.query('userProfiles')
		.withIndex('by_auth_user_id', (q) => q.eq('authUserId', authUserId))
		.first();
	if (!profile || profile.deletedAt !== undefined) {
		throwInvalidInput('That person is not a member of your organization.');
	}
}

/**
 * Assert the address sits on a VERIFIED instance sending domain. A team inbox is
 * hosted on a domain this deployment controls; mirrors the UI's `listVerified`
 * restriction on the server so the "created on a verified domain" guarantee
 * holds regardless of caller (and can never route a hosted inbox onto a domain
 * the instance hasn't proven it owns).
 */
async function assertVerifiedDomain(ctx: MutationCtx, domain: string): Promise<void> {
	const record = await ctx.db
		.query('domains')
		.withIndex('by_domain', (q) => q.eq('domain', domain))
		.first();
	if (!record || record.status !== 'verified') {
		throwInvalidInput('Choose an address on one of your verified domains.');
	}
}

/**
 * Create a hosted team inbox on a verified sending domain. Admin-gated (a team
 * inbox is org infrastructure). The creator becomes the mailbox's `userId` and
 * its first `owner` membership (inserted by `provisionMailbox`); each id in
 * `memberUserIds` (deduped, creator excluded) is added as a `member`.
 */
export const createShared = authedMutation({
	args: {
		address: v.string(),
		displayName: v.optional(v.string()),
		memberUserIds: v.array(v.string()),
	},
	handler: async (ctx, args) => {
		await requireAdminContext(ctx);
		const session = await getBetterAuthSessionWithRole(ctx);
		if (!session?.activeOrganizationId) {
			throwForbidden('No active organization');
		}
		const address = canonicalAddress(args.address);
		const [, domain] = address.split('@');
		if (!domain) {
			throwInvalidInput('Enter a valid email address for the team inbox.');
		}
		await assertVerifiedDomain(ctx, domain);

		// Validate every initial member (deduped, creator excluded) is a real org
		// member up front, so a bogus id fails the whole create rather than
		// silently seeding a dangling membership row.
		const memberIds = [...new Set(args.memberUserIds)].filter((id) => id !== session.userId);
		for (const memberUserId of memberIds) {
			await assertOrgMemberUser(ctx, memberUserId);
		}

		const mailboxId = await createProvisionedMailbox(ctx, {
			userId: session.userId,
			organizationId: session.activeOrganizationId,
			address,
			displayName: args.displayName,
			scope: 'shared',
		});

		const now = Date.now();
		for (const memberUserId of memberIds) {
			await ctx.db.insert('mailboxMembers', {
				mailboxId,
				authUserId: memberUserId,
				role: 'member',
				addedBy: session.userId,
				createdAt: now,
			});
		}

		return mailboxId;
	},
});

/**
 * Every team inbox org-wide with its full roster and pending invites — the
 * data behind the admin "Team inboxes" settings page. Admin-gated by the
 * `adminQuery` wrapper (`organization:manage`): the page exists precisely so
 * an admin can see and manage inboxes they are NOT a member of, so the
 * per-mailbox `requireMailboxAccess` soft-fail used by `members` is the wrong
 * floor here. Bounded: team inboxes are org infrastructure (a handful per
 * deployment), and the `by_scope` range never touches personal mailboxes.
 */
export const listShared = adminQuery({
	args: {},
	handler: async (ctx) => {
		const shared = await ctx.db
			.query('mailboxes')
			.withIndex('by_scope', (q) => q.eq('scope', 'shared'))
			.collect(); // bounded: shared team inboxes only (org infrastructure, a handful; personal rows keep scope unset)
		const live = shared
			.filter((mailbox) => mailbox.status !== 'deleted')
			.sort((a, b) => a.address.localeCompare(b.address));
		return await Promise.all(
			live.map(async (mailbox) => {
				const rows = await ctx.db
					.query('mailboxMembers')
					.withIndex('by_mailbox_user', (q) => q.eq('mailboxId', mailbox._id))
					.collect(); // bounded: one team's roster
				// Owner first, then newest additions — the order the admin list renders.
				rows.sort((a, b) =>
					a.role !== b.role ? (a.role === 'owner' ? -1 : 1) : b.createdAt - a.createdAt
				);
				const members = await Promise.all(
					rows.map(async (row) => {
						const profile = await loadMemberProfile(ctx, row.authUserId);
						return {
							authUserId: row.authUserId,
							role: row.role,
							name: profile.name,
							email: profile.email,
							image: profile.image,
						};
					})
				);
				const pending = await ctx.db
					.query('pendingMailboxMembers')
					.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailbox._id))
					.collect(); // bounded: open invites on one inbox
				return {
					_id: mailbox._id,
					address: mailbox.address,
					displayName: mailbox.displayName ?? null,
					status: mailbox.status,
					kind: mailbox.kind ?? 'hosted',
					createdAt: mailbox.createdAt,
					memberCount: rows.length,
					members,
					pendingInvites: pending.map((p) => p.inviteeEmail).sort(),
				};
			})
		);
	},
});

/**
 * The mailbox's member roster, most-recently-added first. Readable by any
 * member (and, via `requireMailboxAccess`, org owner/admin). Returns `[]` for a
 * caller without access — including a member who was just removed, so the UI
 * clears the roster reactively rather than flashing a permission error.
 */
export const members = authedQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args) => {
		const access = await requireMailboxAccess(ctx, args.mailboxId);
		if (!access.ok) return [];
		const rows = await ctx.db
			.query('mailboxMembers')
			.withIndex('by_mailbox_user', (q) => q.eq('mailboxId', args.mailboxId))
			.collect(); // bounded: one shared inbox's roster (a team, not a crowd)
		rows.sort((a, b) => b.createdAt - a.createdAt);
		return await Promise.all(
			rows.map(async (row) => {
				const profile = await loadMemberProfile(ctx, row.authUserId);
				return {
					_id: row._id,
					authUserId: row.authUserId,
					role: row.role,
					createdAt: row.createdAt,
					isYou: row.authUserId === access.userId,
					name: profile.name,
					email: profile.email,
					image: profile.image,
				};
			})
		);
	},
});

/**
 * The caller's own role on a mailbox (`'owner' | 'member'`), or `null` when
 * they have no access. Watched by the UI and the tests to prove that a removed
 * member loses access the instant their row is deleted.
 */
export const myRole = authedQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args) => {
		// The effective role is derived once, at the choke point
		// (`requireMailboxAccess`), so this query can never drift from the policy
		// that actually gates access (org owner/admin + mailbox userId ⇒ owner;
		// everyone else's explicit membership role).
		const access = await requireMailboxAccess(ctx, args.mailboxId);
		return access.ok ? access.role : null;
	},
});

/** Load the shared mailbox behind a member-management mutation, owner-gated. */
async function requireSharedOwnerAccess(
	ctx: Parameters<typeof requireMailboxAccess>[0],
	mailboxId: Id<'mailboxes'>
) {
	const access = await requireMailboxAccess(ctx, mailboxId, 'owner');
	if (!access.ok) {
		throwForbidden('You do not have permission to manage this inbox.');
	}
	if (access.mailbox.scope !== 'shared') {
		throwInvalidInput('Members can only be managed on a team inbox.');
	}
	return access;
}

/** Add an org member to a shared inbox. No-op if they are already a member. */
export const addMember = authedMutation({
	args: { mailboxId: v.id('mailboxes'), authUserId: v.string() },
	handler: async (ctx, args) => {
		// authz: requireSharedOwnerAccess → requireMailboxAccess(owner) + shared-scope gate.
		const access = await requireSharedOwnerAccess(ctx, args.mailboxId);
		await assertOrgMemberUser(ctx, args.authUserId);
		const existing = await ctx.db
			.query('mailboxMembers')
			.withIndex('by_mailbox_user', (q) =>
				q.eq('mailboxId', args.mailboxId).eq('authUserId', args.authUserId)
			)
			.unique();
		if (existing) return { success: true, alreadyMember: true };
		await ctx.db.insert('mailboxMembers', {
			mailboxId: args.mailboxId,
			authUserId: args.authUserId,
			role: 'member',
			addedBy: access.userId,
			createdAt: Date.now(),
		});
		return { success: true, alreadyMember: false };
	},
});

/**
 * Remove a member. Takes effect immediately — the target's reactive access
 * queries (`myRole`, `members`, `mail/mailbox.get`) return nothing on the next
 * tick. The mailbox's own `userId` (its canonical owner) cannot be removed;
 * ownership must be transferred first. That guard also protects the last owner:
 * `provisionMailbox` and `transferOwnership` keep the single `owner`-role row in
 * lock-step with `mailboxes.userId`, so the only `owner` row is always the
 * canonical owner rejected here — hence no separate last-owner branch.
 */
export const removeMember = authedMutation({
	args: { mailboxId: v.id('mailboxes'), authUserId: v.string() },
	handler: async (ctx, args) => {
		// authz: requireSharedOwnerAccess → requireMailboxAccess(owner) + shared-scope gate.
		const access = await requireSharedOwnerAccess(ctx, args.mailboxId);
		if (args.authUserId === access.mailbox.userId) {
			throwInvalidInput('Transfer inbox ownership before removing the current owner.');
		}
		const row = await ctx.db
			.query('mailboxMembers')
			.withIndex('by_mailbox_user', (q) =>
				q.eq('mailboxId', args.mailboxId).eq('authUserId', args.authUserId)
			)
			.unique();
		if (!row) return { success: true };
		await ctx.db.delete(row._id);
		return { success: true };
	},
});

/**
 * Transfer inbox ownership to another member. The new owner is promoted (added
 * as an owner member if not already present) and becomes the mailbox's
 * canonical `userId`; the previous owner is demoted to a plain member (retaining
 * access). Both changes are reactive and take effect immediately.
 */
export const transferOwnership = authedMutation({
	args: { mailboxId: v.id('mailboxes'), authUserId: v.string() },
	handler: async (ctx, args) => {
		// authz: requireSharedOwnerAccess → requireMailboxAccess(owner) + shared-scope gate.
		const access = await requireSharedOwnerAccess(ctx, args.mailboxId);
		const previousOwnerId = access.mailbox.userId;
		if (args.authUserId === previousOwnerId) {
			return { success: true, alreadyOwner: true };
		}
		// The new owner becomes the mailbox's canonical `userId`, so a bogus id
		// here would brick ownership — validate before any write.
		await assertOrgMemberUser(ctx, args.authUserId);
		const now = Date.now();

		// Promote (or add) the new owner.
		const target = await ctx.db
			.query('mailboxMembers')
			.withIndex('by_mailbox_user', (q) =>
				q.eq('mailboxId', args.mailboxId).eq('authUserId', args.authUserId)
			)
			.unique();
		if (target) {
			if (target.role !== 'owner') await ctx.db.patch(target._id, { role: 'owner' });
		} else {
			await ctx.db.insert('mailboxMembers', {
				mailboxId: args.mailboxId,
				authUserId: args.authUserId,
				role: 'owner',
				addedBy: access.userId,
				createdAt: now,
			});
		}

		// Demote the previous owner to a plain member (keeps their access).
		const previous = await ctx.db
			.query('mailboxMembers')
			.withIndex('by_mailbox_user', (q) =>
				q.eq('mailboxId', args.mailboxId).eq('authUserId', previousOwnerId)
			)
			.unique();
		if (previous) {
			await ctx.db.patch(previous._id, { role: 'member' });
		}

		// The mailbox's canonical owner id follows the transfer.
		await ctx.db.patch(args.mailboxId, { userId: args.authUserId, updatedAt: now });
		return { success: true, alreadyOwner: false };
	},
});
