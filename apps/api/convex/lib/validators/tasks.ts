import { v } from 'convex/values';

/**
 * Who can see a task:
 *   - `private`: its creator only. A private task is never assigned to anyone
 *     else, because the assignee could not see it.
 *   - `everyone`: every member of the workspace.
 *   - `group`: the members of one member group (say, Management), plus the
 *     task's creator and assignee. Owners and admins outside the group do not
 *     see it: a group exists to keep a task between its members.
 */
export const TASK_VISIBILITIES = ['private', 'everyone', 'group'] as const;
export type TaskVisibility = (typeof TASK_VISIBILITIES)[number];
export const taskVisibilityValidator = v.union(
	v.literal('private'),
	v.literal('everyone'),
	v.literal('group')
);

/** `dropped` is "won't do"; it restores to `open` like `done` does. */
export const TASK_STATUSES = ['open', 'done', 'dropped'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const taskStatusValidator = v.union(
	v.literal('open'),
	v.literal('done'),
	v.literal('dropped')
);

/** The kind of conversation a company index row points at. */
export const companyThreadKindValidator = v.union(v.literal('mail'), v.literal('team'));
