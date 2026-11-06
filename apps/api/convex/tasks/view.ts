/**
 * The shape a task reaches the browser in, and the reads that build it.
 *
 * A task's source conversation is described only to a viewer who could open
 * it: a teammate sees that a task came from a conversation, never the subject
 * of a mailbox they cannot read.
 */

import { companyNameFromKey } from '@owlat/shared/companyKey';
import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { isSharedInboxReader } from '../inbox/access';
import { isFeatureEnabled } from '../lib/featureFlags';
import type { OrganizationRole } from '../lib/sessionOrganization';
import { loadAccessibleMailboxes } from '../mail/permissions';
import { canSeeTask, type TaskViewer } from './access';
import { loadViewer } from './members';

export type TaskSourceView =
	| {
			kind: 'mail';
			mailThreadId: Id<'mailThreads'>;
			mailboxId: Id<'mailboxes'>;
			/** The thread's newest message: the Postbox reader opens a thread by a message. */
			messageId: Id<'mailMessages'> | null;
			canOpen: boolean;
			subject: string | null;
	  }
	| {
			kind: 'team';
			conversationThreadId: Id<'conversationThreads'>;
			canOpen: boolean;
			subject: string | null;
	  };

export interface TaskView {
	_id: Id<'tasks'>;
	title: string;
	notes: string | null;
	visibility: Doc<'tasks'>['visibility'];
	groupId: Id<'memberGroups'> | null;
	groupName: string | null;
	createdBy: string;
	assigneeUserId: string;
	status: Doc<'tasks'>['status'];
	dueAt: number | null;
	companyKey: string | null;
	companyName: string | null;
	source: TaskSourceView | null;
	completedAt: number | null;
	completedBy: string | null;
	createdAt: number;
	updatedAt: number;
}

export interface ViewerContext {
	viewer: TaskViewer;
	readableMailboxIds: ReadonlySet<string>;
	teamReader: boolean;
	groupNames: Map<string, string | null>;
}

export interface SessionLike {
	userId: string;
	role: OrganizationRole | null;
	activeOrganizationId: string;
}

export async function loadViewerContext(
	ctx: QueryCtx,
	session: SessionLike
): Promise<ViewerContext> {
	const [viewer, mailboxes, inboxOn] = await Promise.all([
		loadViewer(ctx, session.userId),
		loadAccessibleMailboxes(ctx, session.userId, session.activeOrganizationId),
		isFeatureEnabled(ctx, 'inbox'),
	]);
	return {
		viewer,
		readableMailboxIds: new Set(mailboxes.map((m) => m._id as string)),
		teamReader: isSharedInboxReader(session) && inboxOn,
		groupNames: new Map(),
	};
}

async function groupName(
	ctx: QueryCtx,
	context: ViewerContext,
	groupId: Id<'memberGroups'>
): Promise<string | null> {
	if (!context.groupNames.has(groupId)) {
		const group = await ctx.db.get(groupId);
		context.groupNames.set(groupId, group?.name ?? null);
	}
	return context.groupNames.get(groupId) ?? null;
}

async function sourceView(
	ctx: QueryCtx,
	context: ViewerContext,
	task: Doc<'tasks'>
): Promise<TaskSourceView | null> {
	if (task.sourceMailThreadId && task.sourceMailboxId) {
		const canOpen = context.readableMailboxIds.has(task.sourceMailboxId);
		const thread = canOpen ? await ctx.db.get(task.sourceMailThreadId) : null;
		return {
			kind: 'mail',
			mailThreadId: task.sourceMailThreadId,
			mailboxId: task.sourceMailboxId,
			messageId: thread?.latestMessageId ?? null,
			canOpen: canOpen && thread !== null,
			subject: thread?.latestSubject ?? null,
		};
	}
	if (task.sourceConversationThreadId) {
		const thread = context.teamReader ? await ctx.db.get(task.sourceConversationThreadId) : null;
		return {
			kind: 'team',
			conversationThreadId: task.sourceConversationThreadId,
			canOpen: thread !== null,
			subject: thread?.subject ?? null,
		};
	}
	return null;
}

/** The view of a task the viewer may see, or null when they may not. */
export async function toTaskView(
	ctx: QueryCtx,
	context: ViewerContext,
	task: Doc<'tasks'>
): Promise<TaskView | null> {
	if (!canSeeTask(task, context.viewer)) return null;
	return {
		_id: task._id,
		title: task.title,
		notes: task.notes ?? null,
		visibility: task.visibility,
		groupId: task.groupId ?? null,
		groupName: task.groupId ? await groupName(ctx, context, task.groupId) : null,
		createdBy: task.createdBy,
		assigneeUserId: task.assigneeUserId,
		status: task.status,
		dueAt: task.dueAt ?? null,
		companyKey: task.companyKey ?? null,
		companyName: task.companyKey ? companyNameFromKey(task.companyKey) : null,
		source: await sourceView(ctx, context, task),
		completedAt: task.completedAt ?? null,
		completedBy: task.completedBy ?? null,
		createdAt: task.createdAt,
		updatedAt: task.updatedAt,
	};
}

export async function toTaskViews(
	ctx: QueryCtx,
	context: ViewerContext,
	tasks: readonly Doc<'tasks'>[]
): Promise<TaskView[]> {
	const out: TaskView[] = [];
	for (const task of tasks) {
		const view = await toTaskView(ctx, context, task);
		if (view) out.push(view);
	}
	return out;
}

/** Open tasks first by due date (undated last), then by when they were added. */
export function compareOpenTasks(a: TaskView, b: TaskView): number {
	const ad = a.dueAt ?? Number.POSITIVE_INFINITY;
	const bd = b.dueAt ?? Number.POSITIVE_INFINITY;
	if (ad !== bd) return ad - bd;
	return b.createdAt - a.createdAt;
}
