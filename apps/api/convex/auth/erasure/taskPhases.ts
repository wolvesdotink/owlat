/**
 * Member erasure phases for tasks, member groups and the company index, as
 * declared in `taskRelations.ts`.
 *
 * Every range here is one the phase's own writes empty: a delete, or a patch
 * of the indexed field, so each phase resumes by reading its ranges again.
 */

import type { MutationCtx } from '../../_generated/server';
import { drainEach } from '../../contacts/erasure/phaseKit';
import { deleteRanges } from './mailboxPhases';
import { DELETED_ACCOUNT_ID, forEachPersonalMailbox, type MemberPhaseRunner } from './phaseKit';

/**
 * A personal mailbox's company index rows and cursor, and the link from any
 * task to its conversations. The task stays with whoever can see it; only the
 * pointer into the erased mailbox goes. Runs before the mailbox row is
 * deleted, while the mailbox id still finds the rows. The mailbox is already
 * `deleted` by then, so the indexer (active mailboxes only) writes no new row.
 */
export const eraseMailboxTaskLinks: MemberPhaseRunner = (phase) =>
	forEachPersonalMailbox(phase, async (mailbox) => {
		const { ctx, budget } = phase;
		const id = mailbox._id;
		const isIndexEmpty = await deleteRanges(phase, [
			(n) =>
				ctx.db
					.query('companyThreads')
					.withIndex('by_mailbox_last', (q) => q.eq('mailboxId', id))
					.take(n),
			(n) =>
				ctx.db
					.query('companyIndexCursors')
					.withIndex('by_mailbox_stream', (q) => q.eq('mailboxId', id))
					.take(n),
		]);
		if (!isIndexEmpty) return false;
		return drainEach(
			budget,
			(n) =>
				ctx.db
					.query('tasks')
					.withIndex('by_source_mailbox', (q) => q.eq('sourceMailboxId', id))
					.take(n),
			(task) =>
				ctx.db.patch(task._id, {
					sourceMailboxId: undefined,
					sourceMailThreadId: undefined,
					sourceThreadItemId: undefined,
				})
		);
	});

/**
 * The member's private tasks go. Every other task they created, own or
 * finished stays with its audience, the member's id replaced by
 * '[deleted account]'. A private task's assignee is always its creator, so
 * the first range holds all of them.
 */
export const eraseTasks: MemberPhaseRunner = async ({ ctx, authUserId: uid, budget }) => {
	const isCreatedEmpty = await drainEach(
		budget,
		(n) =>
			ctx.db
				.query('tasks')
				.withIndex('by_creator_status', (q) => q.eq('createdBy', uid))
				.take(n),
		async (task) => {
			if (task.visibility === 'private') {
				await ctx.db.delete(task._id);
				return;
			}
			await ctx.db.patch(task._id, {
				createdBy: DELETED_ACCOUNT_ID,
				...(task.assigneeUserId === uid ? { assigneeUserId: DELETED_ACCOUNT_ID } : {}),
				...(task.completedBy === uid ? { completedBy: DELETED_ACCOUNT_ID } : {}),
			});
		}
	);
	if (!isCreatedEmpty) return { isDone: false };
	const isAssignedEmpty = await drainEach(
		budget,
		(n) =>
			ctx.db
				.query('tasks')
				.withIndex('by_assignee_status_due', (q) => q.eq('assigneeUserId', uid))
				.take(n),
		(task) =>
			ctx.db.patch(task._id, {
				assigneeUserId: DELETED_ACCOUNT_ID,
				...(task.completedBy === uid ? { completedBy: DELETED_ACCOUNT_ID } : {}),
			})
	);
	if (!isAssignedEmpty) return { isDone: false };
	return {
		isDone: await drainEach(
			budget,
			(n) =>
				ctx.db
					.query('tasks')
					.withIndex('by_completed_by', (q) => q.eq('completedBy', uid))
					.take(n),
			(task) => ctx.db.patch(task._id, { completedBy: DELETED_ACCOUNT_ID })
		),
	};
};

/**
 * The member leaves every group. The groups and the other memberships stay;
 * who created a group or added someone to one becomes '[deleted account]'.
 */
export const eraseMemberGroups: MemberPhaseRunner = async (phase) => {
	const { ctx, authUserId: uid, budget } = phase;
	const isMembershipsEmpty = await deleteRanges(phase, [
		(n) =>
			ctx.db
				.query('memberGroupMembers')
				.withIndex('by_user', (q) => q.eq('userId', uid))
				.take(n),
	]);
	if (!isMembershipsEmpty) return { isDone: false };
	const isAddedEmpty = await drainEach(
		budget,
		(n) =>
			ctx.db
				.query('memberGroupMembers')
				.withIndex('by_added_by', (q) => q.eq('addedBy', uid))
				.take(n),
		(row) => ctx.db.patch(row._id, { addedBy: DELETED_ACCOUNT_ID })
	);
	if (!isAddedEmpty) return { isDone: false };
	return {
		isDone: await drainEach(
			budget,
			(n) =>
				ctx.db
					.query('memberGroups')
					.withIndex('by_created_by', (q) => q.eq('createdBy', uid))
					.take(n),
			(group) => ctx.db.patch(group._id, { createdBy: DELETED_ACCOUNT_ID })
		),
	};
};

/** End-state probes for `remainingMemberData`: rows that still name the member. */
export function taskProbes(ctx: MutationCtx, uid: string): Array<[string, () => Promise<unknown>]> {
	return [
		[
			'tasks created',
			() =>
				ctx.db
					.query('tasks')
					.withIndex('by_creator_status', (q) => q.eq('createdBy', uid))
					.first(),
		],
		[
			'tasks assigned',
			() =>
				ctx.db
					.query('tasks')
					.withIndex('by_assignee_status_due', (q) => q.eq('assigneeUserId', uid))
					.first(),
		],
		[
			'memberGroupMembers',
			() =>
				ctx.db
					.query('memberGroupMembers')
					.withIndex('by_user', (q) => q.eq('userId', uid))
					.first(),
		],
	];
}
