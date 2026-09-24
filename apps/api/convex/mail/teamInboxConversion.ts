/**
 * Turn a mailbox that already exists into a team inbox.
 *
 * A mailbox is a team inbox because its `scope` says so, not because of how it
 * was created or which transport carries its mail. The create paths
 * (`mailboxMembers.createShared` for a hosted address,
 * `external/sharedInbox._connectSharedInternal` for a connected account) stand a
 * team inbox up from nothing. This one re-scopes a personal mailbox that really
 * belongs to the team, typically an `info@` someone connected through the
 * personal "connect your mailbox" flow. Its mail, folders, sync, credentials and
 * sending transport stay exactly as they are. What changes is who may use it:
 * `mailboxMembers` rows now govern access, and the personal-external surfaces
 * (`external/personalAccount.ts`) stop treating it as the owner's own account in
 * the same write, because they read the mailbox's scope rather than a copy.
 *
 * Policy:
 *   - Org owner/admin only: a team inbox is org infrastructure, as on create.
 *   - The caller's OWN mailbox only. Converting shows every message already in
 *     it to the team, so the person whose mail it is has to be the one who
 *     decides. An admin can already read any mailbox in the org, but may not
 *     hand someone else's private mail to a whole team on their behalf.
 *   - The mailbox must be active and personal and, when it is external, still
 *     connected: a disconnected account or a completed move's read-only archive
 *     would give the team an inbox that never receives mail.
 *   - It must not be half-way through a "move my mailbox here"
 *     (`mail/mailboxMove.ts`). That flow belongs to the owner's personal
 *     mailbox, and its remaining steps (archive, cancel) would otherwise act on
 *     the team inbox.
 *
 * The owner stays the owner (their `mailboxes.userId` and owner membership row
 * are untouched), so ownership can be handed on later with
 * `mailboxMembers.transferOwnership` like any other team inbox.
 *
 *   Public: convertibleMailboxes, convertToTeamInbox
 */

import { v } from 'convex/values';
import type { QueryCtx, MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { adminQuery } from '../lib/authedFunctions';
import { hasPermission, requirePermission } from '../lib/sessionOrganization';
import { throwForbidden, throwInvalidState } from '../_utils/errors';
import { postboxMutation } from './_helpers';
import { loadPersonalMailboxForUser } from './permissions';
import { seedSharedInboxRoster } from './mailboxMembers';

/** Why a mailbox cannot become a team inbox for this caller. */
type ConversionBlocker = 'not_yours' | 'inactive' | 'disconnected' | 'moving';

type Conversion =
	| { ok: true; mailbox: Doc<'mailboxes'> }
	| { ok: false; reason: ConversionBlocker };

/**
 * Can the caller turn this mailbox into a team inbox? The one predicate behind
 * both the offer (`convertibleMailboxes`) and the write (`convertToTeamInbox`),
 * so the page never offers a mailbox the mutation would refuse.
 */
async function checkConversion(
	ctx: QueryCtx | MutationCtx,
	mailboxId: Id<'mailboxes'>,
	caller: { userId: string; activeOrganizationId: string }
): Promise<Conversion> {
	const mailbox = await loadPersonalMailboxForUser(ctx, mailboxId, caller.userId);
	if (!mailbox || mailbox.organizationId !== caller.activeOrganizationId) {
		return { ok: false, reason: 'not_yours' };
	}
	if (mailbox.status !== 'active') return { ok: false, reason: 'inactive' };
	if (mailbox.kind === 'external') {
		const account = mailbox.externalAccountId ? await ctx.db.get(mailbox.externalAccountId) : null;
		if (!account || account.status === 'disconnected' || account.purgeStartedAt !== undefined) {
			return { ok: false, reason: 'disconnected' };
		}
	}
	if (await isInUnfinishedMove(ctx, mailbox, caller.userId)) return { ok: false, reason: 'moving' };
	return { ok: true, mailbox };
}

/** Is this mailbox the source or the new hosted home of a move not yet archived? */
async function isInUnfinishedMove(
	ctx: QueryCtx | MutationCtx,
	mailbox: Doc<'mailboxes'>,
	userId: string
): Promise<boolean> {
	const moves = await ctx.db
		.query('mailboxMoves')
		.withIndex('by_user', (q) => q.eq('userId', userId))
		.collect(); // bounded: one member's moves (at most one live, a few finished)
	return moves.some(
		(move) =>
			move.stage !== 'archived' &&
			(move.sourceMailboxId === mailbox._id || move.hostedMailboxId === mailbox._id)
	);
}

/**
 * The caller's own mailboxes that can become a team inbox — what the admin
 * Team inboxes page offers to convert. Empty for a caller with none, so the
 * page shows no convert action at all.
 */
export const convertibleMailboxes = adminQuery({
	args: {},
	handler: async (ctx, _args, session) => {
		const owned = await ctx.db
			.query('mailboxes')
			.withIndex('by_user', (q) => q.eq('userId', session.userId))
			.collect(); // bounded: one user's own mailboxes (typically 1–2)
		const checks = await Promise.all(
			owned.map((mailbox) => checkConversion(ctx, mailbox._id, session))
		);
		return checks
			.flatMap((check) => (check.ok ? [check.mailbox] : []))
			.sort((a, b) => a.address.localeCompare(b.address))
			.map((mailbox) => ({
				mailboxId: mailbox._id,
				address: mailbox.address,
				displayName: mailbox.displayName ?? null,
			}));
	},
});

const BLOCKER_MESSAGES: Record<Exclude<ConversionBlocker, 'not_yours'>, string> = {
	inactive: 'This mailbox is not active.',
	disconnected: 'Reconnect this mailbox before turning it into a team inbox.',
	moving: 'Finish or cancel moving this mailbox before turning it into a team inbox.',
};

/**
 * Make one of the caller's own personal mailboxes a team inbox and add the
 * given org members to it. Transactional: a bogus member id throws and the
 * mailbox stays personal.
 */
export const convertToTeamInbox = postboxMutation({
	args: {
		mailboxId: v.id('mailboxes'),
		memberUserIds: v.array(v.string()),
		displayName: v.optional(v.string()),
	},
	handler: async (ctx, args, session) => {
		requirePermission(
			hasPermission(session.role, 'organization:manage'),
			'Only owners and admins can create a team inbox.'
		);
		const conversion = await checkConversion(ctx, args.mailboxId, session);
		if (!conversion.ok) {
			if (conversion.reason === 'not_yours') {
				throwForbidden('Only the owner of a personal mailbox can turn it into a team inbox.');
			}
			throwInvalidState(BLOCKER_MESSAGES[conversion.reason]);
		}
		const { mailbox } = conversion;

		const now = Date.now();
		const displayName = args.displayName?.trim();
		await ctx.db.patch(mailbox._id, {
			scope: 'shared',
			...(displayName ? { displayName } : {}),
			updatedAt: now,
		});
		if (mailbox.externalAccountId) {
			// Remove after the next release: the deprecated mirror the previous
			// release reads (see `schema/mailAccounts.ts`).
			await ctx.db.patch(mailbox.externalAccountId, { scope: 'shared', updatedAt: now });
		}
		await seedSharedInboxRoster(ctx, {
			mailboxId: mailbox._id,
			creatorUserId: session.userId,
			memberUserIds: args.memberUserIds,
			now,
		});
		await ctx.db.insert('mailAuditLog', {
			mailboxId: mailbox._id,
			event: 'mailbox.converted_to_team_inbox',
			details: mailbox.address,
			occurredAt: now,
		});
		return { mailboxId: mailbox._id };
	},
});
