/**
 * Member erasure phases for the thread brief rows that name the member
 * (relations in `threadBriefRelations.ts`). The rows under a personal mailbox
 * go with its threads and drafts (`mailboxPhases.ts` via
 * `contacts/erasure/threadBriefPhases.ts`); these cover the rows outside it,
 * in Team Inbox threads and shared mailboxes.
 */

import { drainEach } from '../../contacts/erasure/phaseKit';
import { DELETED_ACCOUNT_ID, type MemberPhaseRunner } from './phaseKit';

/** The member's own view override and "last seen" markers, on every thread. */
export const eraseThreadViewerState: MemberPhaseRunner = async ({ ctx, authUserId, budget }) => ({
	isDone: await drainEach(
		budget,
		(n) =>
			ctx.db
				.query('threadViewerState')
				.withIndex('by_user_and_mail_thread', (q) => q.eq('userId', authUserId))
				.take(n),
		(row) => ctx.db.delete(row._id)
	),
});

/**
 * Team items assigned to the member stay with the organization and read
 * Unassigned (D4). The patch moves each row out of the assignee range.
 */
export const eraseThreadItemAssignments: MemberPhaseRunner = async ({
	ctx,
	authUserId,
	budget,
}) => ({
	isDone: await drainEach(
		budget,
		(n) =>
			ctx.db
				.query('threadItems')
				.withIndex('by_assignee', (q) => q.eq('assigneeUserId', authUserId))
				.take(n),
		(item) =>
			ctx.db.patch(item._id, {
				assigneeUserId: undefined,
				revision: item.revision + 1,
				updatedAt: Date.now(),
			})
	),
});

/** The member's emoji reactions on internal notes and discussion messages. */
export const eraseNoteReactions: MemberPhaseRunner = async ({ ctx, authUserId, budget }) => ({
	isDone: await drainEach(
		budget,
		(n) =>
			ctx.db
				.query('noteReactions')
				.withIndex('by_user', (q) => q.eq('userId', authUserId))
				.take(n),
		(row) => ctx.db.delete(row._id)
	),
});

/**
 * The member's corrections of items stay for the interpretation eval
 * (structure only); who made them goes. The patch moves each row out of the
 * user range.
 */
export const eraseThreadItemCorrections: MemberPhaseRunner = async ({
	ctx,
	authUserId,
	budget,
}) => ({
	isDone: await drainEach(
		budget,
		(n) =>
			ctx.db
				.query('threadItemCorrections')
				.withIndex('by_user', (q) => q.eq('userId', authUserId))
				.take(n),
		(row) => ctx.db.patch(row._id, { userId: DELETED_ACCOUNT_ID })
	),
});
