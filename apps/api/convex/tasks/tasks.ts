/**
 * Reading tasks. Every read filters through `canSeeTask` (tasks/access.ts), so
 * a private task never leaves its owner and a group task never leaves its
 * group, whichever list or page asks.
 */

import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { isSharedInboxReader } from '../inbox/access';
import { authedQuery } from '../lib/authedFunctions';
import { isGroupMember } from './members';
import { compareOpenTasks, loadViewerContext, toTaskViews, type TaskView } from './view';

/** One list's cap. A person with more open tasks than this sees the first ones by due date. */
export const LIST_LIMIT = 200;
/** How many finished tasks the Done list goes back. */
const DONE_LIMIT = 100;

export const TASK_LIST_VIEWS = ['mine', 'everyone', 'group', 'private', 'created', 'done'] as const;
const listViewValidator = v.union(
	v.literal('mine'),
	v.literal('everyone'),
	v.literal('group'),
	v.literal('private'),
	v.literal('created'),
	v.literal('done')
);

async function openAssignedTo(ctx: QueryCtx, userId: string) {
	return await ctx.db
		.query('tasks')
		.withIndex('by_assignee_status_due', (q) => q.eq('assigneeUserId', userId).eq('status', 'open'))
		.take(LIST_LIMIT);
}

/** Finished tasks: done, and dropped (won't do), which the Done list restores from. */
const FINISHED_STATUSES = ['done', 'dropped'] as const;

async function finishedVisibleTo(ctx: QueryCtx, userId: string, groupIds: ReadonlySet<string>) {
	const lists = await Promise.all(
		FINISHED_STATUSES.flatMap((status) => [
			ctx.db
				.query('tasks')
				.withIndex('by_assignee_status_due', (q) =>
					q.eq('assigneeUserId', userId).eq('status', status)
				)
				.order('desc')
				.take(DONE_LIMIT),
			ctx.db
				.query('tasks')
				.withIndex('by_creator_status', (q) => q.eq('createdBy', userId).eq('status', status))
				.order('desc')
				.take(DONE_LIMIT),
			ctx.db
				.query('tasks')
				.withIndex('by_visibility_status_due', (q) =>
					q.eq('visibility', 'everyone').eq('status', status)
				)
				.order('desc')
				.take(DONE_LIMIT),
			...[...groupIds].map((groupId) =>
				ctx.db
					.query('tasks')
					.withIndex('by_group_status_due', (q) =>
						q.eq('groupId', groupId as Doc<'tasks'>['groupId']).eq('status', status)
					)
					.order('desc')
					.take(DONE_LIMIT)
			),
		])
	);
	const byId = new Map<string, Doc<'tasks'>>();
	for (const task of lists.flat()) byId.set(task._id, task);
	return [...byId.values()]
		.sort((a, b) => (b.completedAt ?? b.updatedAt) - (a.completedAt ?? a.updatedAt))
		.slice(0, DONE_LIMIT);
}

/**
 * One task list:
 *   - `mine`: open tasks assigned to the viewer, whatever their visibility;
 *   - `everyone`: open tasks the whole workspace sees;
 *   - `group`: open tasks of one group the viewer belongs to;
 *   - `private`: the viewer's open private tasks;
 *   - `created`: open tasks the viewer handed to someone else;
 *   - `done`: recently finished tasks the viewer can see, done or dropped.
 */
// authz: every row passes canSeeTask (tasks/access.ts) in toTaskViews; a group list needs membership.
export const list = authedQuery({
	args: { view: listViewValidator, groupId: v.optional(v.id('memberGroups')) },
	handler: async (ctx, args, session): Promise<TaskView[]> => {
		const context = await loadViewerContext(ctx, session);
		const { userId } = session;
		let rows: Doc<'tasks'>[];
		switch (args.view) {
			case 'mine':
				rows = await openAssignedTo(ctx, userId);
				break;
			case 'everyone':
				rows = await ctx.db
					.query('tasks')
					.withIndex('by_visibility_status_due', (q) =>
						q.eq('visibility', 'everyone').eq('status', 'open')
					)
					.take(LIST_LIMIT);
				break;
			case 'group': {
				if (!args.groupId || !(await isGroupMember(ctx, args.groupId, userId))) return [];
				const groupId = args.groupId;
				rows = await ctx.db
					.query('tasks')
					.withIndex('by_group_status_due', (q) => q.eq('groupId', groupId).eq('status', 'open'))
					.take(LIST_LIMIT);
				break;
			}
			case 'private':
				rows = (
					await ctx.db
						.query('tasks')
						.withIndex('by_creator_status', (q) => q.eq('createdBy', userId).eq('status', 'open'))
						.take(LIST_LIMIT)
				).filter((task) => task.visibility === 'private');
				break;
			case 'created':
				rows = (
					await ctx.db
						.query('tasks')
						.withIndex('by_creator_status', (q) => q.eq('createdBy', userId).eq('status', 'open'))
						.take(LIST_LIMIT)
				).filter((task) => task.assigneeUserId !== userId);
				break;
			case 'done':
				return await toTaskViews(
					ctx,
					context,
					await finishedVisibleTo(ctx, userId, context.viewer.groupIds)
				);
		}
		return (await toTaskViews(ctx, context, rows)).sort(compareOpenTasks);
	},
});

/** How many open tasks the viewer owns, for the navigation badge. */
// authz: counts only the caller's own assigned tasks.
export const openCount = authedQuery({
	args: {},
	handler: async (ctx, _args, session): Promise<number> =>
		(await openAssignedTo(ctx, session.userId)).length,
});

/** The open tasks about one company that the viewer can see. */
// authz: every row passes canSeeTask (tasks/access.ts) in toTaskViews.
export const forCompany = authedQuery({
	args: { companyKey: v.string() },
	handler: async (ctx, args, session): Promise<TaskView[]> => {
		const context = await loadViewerContext(ctx, session);
		const rows = await ctx.db
			.query('tasks')
			.withIndex('by_company_status', (q) =>
				q.eq('companyKey', args.companyKey).eq('status', 'open')
			)
			.take(LIST_LIMIT);
		return (await toTaskViews(ctx, context, rows)).sort(compareOpenTasks);
	},
});

/**
 * The tasks taken from one conversation that the viewer can see, open ones
 * first. Empty for a conversation the viewer cannot open.
 */
// authz: the thread must be one the viewer can open; every row passes canSeeTask (tasks/access.ts) in toTaskViews.
export const forThread = authedQuery({
	args: {
		mailThreadId: v.optional(v.id('mailThreads')),
		conversationThreadId: v.optional(v.id('conversationThreads')),
	},
	handler: async (ctx, args, session): Promise<TaskView[]> => {
		const { mailThreadId, conversationThreadId } = args;
		const context = await loadViewerContext(ctx, session);
		let rows: Doc<'tasks'>[] = [];
		if (mailThreadId) {
			const thread = await ctx.db.get(mailThreadId);
			if (!thread || !context.readableMailboxIds.has(thread.mailboxId)) return [];
			rows = await ctx.db
				.query('tasks')
				.withIndex('by_source_mail_thread', (q) => q.eq('sourceMailThreadId', mailThreadId))
				.take(50);
		} else if (conversationThreadId) {
			// The Team Inbox is for shared-inbox readers (inbox/access.ts) while it is on.
			if (!isSharedInboxReader(session) || !context.teamReader) return [];
			rows = await ctx.db
				.query('tasks')
				.withIndex('by_source_conversation_thread', (q) =>
					q.eq('sourceConversationThreadId', conversationThreadId)
				)
				.take(50);
		}
		if (rows.length === 0) return [];
		const views = await toTaskViews(ctx, context, rows);
		return views.sort((a, b) =>
			a.status === b.status ? compareOpenTasks(a, b) : a.status === 'open' ? -1 : 1
		);
	},
});

/** One task, or null when it does not exist or the viewer may not see it. */
// authz: the row passes canSeeTask (tasks/access.ts) in toTaskViews.
export const get = authedQuery({
	args: { taskId: v.id('tasks') },
	handler: async (ctx, args, session): Promise<TaskView | null> => {
		const task = await ctx.db.get(args.taskId);
		if (!task) return null;
		const [view] = await toTaskViews(ctx, await loadViewerContext(ctx, session), [task]);
		return view ?? null;
	},
});
