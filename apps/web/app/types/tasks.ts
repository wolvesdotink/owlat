import type { FunctionArgs, FunctionReturnType } from 'convex/server';
import type { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

/** A task as the backend hands it to the browser (apps/api/convex/tasks/view.ts). */
export type TaskView = FunctionReturnType<typeof api.tasks.tasks.list>[number];
export type TaskSource = NonNullable<TaskView['source']>;
export type TaskVisibility = TaskView['visibility'];
export type TaskStatus = TaskView['status'];
/** One of the lists `api.tasks.tasks.list` reads. */
export type TaskListView = FunctionArgs<typeof api.tasks.tasks.list>['view'];
/** A member group, as `api.tasks.groups.list` describes it to the viewer. */
export type TaskGroup = FunctionReturnType<typeof api.tasks.groups.list>[number];

/**
 * Who a task is shown to. A group audience names its group; the other two
 * name none, which is what the backend's audience check expects.
 */
export type TaskAudience =
	| { visibility: 'private' }
	| { visibility: 'everyone' }
	| { visibility: 'group'; groupId: Id<'memberGroups'> };

/** A workspace member, as the pickers show one. User ids are BetterAuth ids. */
export interface TaskMember {
	userId: string;
	name: string | null;
	email: string;
	image: string | null;
}

/** The props of `components/tasks/TaskCreatePopover.vue`, for surfaces that pass them along. */
export interface TaskCreateContext {
	mailThreadId?: Id<'mailThreads'>;
	conversationThreadId?: Id<'conversationThreads'>;
	threadItemId?: Id<'threadItems'>;
	companyKey?: string;
	defaultTitle?: string;
}
