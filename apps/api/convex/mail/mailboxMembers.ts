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
import { authedMutation, authedQuery } from '../lib/authedFunctions';
import type { Id } from '../_generated/dataModel';
import { requireAdminContext, getBetterAuthSessionWithRole } from '../lib/sessionOrganization';
import { throwForbidden, throwInvalidInput, throwAlreadyExists } from '../_utils/errors';
import { requireMailboxAccess } from './permissions';
import { provisionMailbox, canonicalAddress } from './mailbox';

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

		const existing = await ctx.db
			.query('mailboxes')
			.withIndex('by_address', (q) => q.eq('address', address))
			.first();
		if (existing) {
			throwAlreadyExists(`A mailbox for ${address} already exists.`);
		}

		const mailboxId = await provisionMailbox(ctx, {
			userId: session.userId,
			organizationId: session.activeOrganizationId,
			address,
			domain,
			displayName: args.displayName,
			scope: 'shared',
		});

		const now = Date.now();
		const added = new Set<string>([session.userId]);
		for (const memberUserId of args.memberUserIds) {
			if (added.has(memberUserId)) continue;
			added.add(memberUserId);
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
		const s = await getBetterAuthSessionWithRole(ctx);
		if (!s || !s.role) return null;
		const access = await requireMailboxAccess(ctx, args.mailboxId);
		if (!access.ok) return null;
		// Org owner/admin (or the mailbox's own userId) get owner-level access
		// without a membership row; everyone else has an explicit row.
		if (s.role === 'owner' || s.role === 'admin' || access.mailbox.userId === s.userId) {
			return 'owner' as const;
		}
		const row = await ctx.db
			.query('mailboxMembers')
			.withIndex('by_mailbox_user', (q) =>
				q.eq('mailboxId', args.mailboxId).eq('authUserId', s.userId)
			)
			.unique();
		return row?.role ?? null;
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
 * tick. Cannot remove the mailbox's own `userId` (transfer ownership first),
 * nor the last remaining owner.
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
		if (row.role === 'owner') {
			const owners = (
				await ctx.db
					.query('mailboxMembers')
					.withIndex('by_mailbox_user', (q) => q.eq('mailboxId', args.mailboxId))
					.collect()
			) // bounded: one shared inbox's roster
				.filter((m) => m.role === 'owner');
			if (owners.length <= 1) {
				throwInvalidInput('A team inbox must keep at least one owner.');
			}
		}
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
