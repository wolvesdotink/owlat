/**
 * The browser's half of the task audience rules (apps/api/convex/tasks/access.ts),
 * so a picker only offers what the backend will accept:
 *   - Only me: the task is the viewer's own, so it is assigned to the viewer;
 *   - Everyone: any workspace member may own it;
 *   - a group: the viewer must belong to the group, and so must the assignee.
 * Making an existing task private is allowed only to someone who created it
 * and owns it, because it takes the task away from everyone else.
 *
 * The backend checks all of this again; these helpers only keep the pickers honest.
 */
import type { Id } from '@owlat/api/dataModel';
import type {
	TaskAudience,
	TaskGroup,
	TaskListView,
	TaskMember,
	TaskSource,
	TaskView,
} from '~/types/tasks';

export const TASK_PRIVATE_AUDIENCE: TaskAudience = { visibility: 'private' };

/** A stable string for an audience: `private`, `everyone` or `group:<id>`. */
export function taskAudienceKey(audience: TaskAudience): string {
	return audience.visibility === 'group' ? `group:${audience.groupId}` : audience.visibility;
}

export function parseTaskAudienceKey(key: string): TaskAudience | null {
	if (key === 'private' || key === 'everyone') return { visibility: key };
	if (key.startsWith('group:') && key.length > 'group:'.length) {
		return { visibility: 'group', groupId: key.slice('group:'.length) as Id<'memberGroups'> };
	}
	return null;
}

/** The audience a task has now. */
export function taskAudienceOf(task: Pick<TaskView, 'visibility' | 'groupId'>): TaskAudience {
	if (task.visibility === 'group' && task.groupId) {
		return { visibility: 'group', groupId: task.groupId };
	}
	return task.visibility === 'everyone' ? { visibility: 'everyone' } : TASK_PRIVATE_AUDIENCE;
}

export function sameTaskAudience(a: TaskAudience, b: TaskAudience): boolean {
	return taskAudienceKey(a) === taskAudienceKey(b);
}

/**
 * The groups a task can be shown to by this viewer: the ones they belong to.
 * `current` keeps a task's own group listed for a viewer who has left it, so
 * the picker can still show where the task is.
 */
export function taskAudienceGroups(
	groups: readonly TaskGroup[],
	current?: TaskAudience
): TaskGroup[] {
	const currentGroupId = current?.visibility === 'group' ? current.groupId : null;
	return groups.filter((group) => group.isMember || group._id === currentGroupId);
}

/** The members a task with this audience may be assigned to, the viewer first. */
export function taskAssigneeOptions(
	audience: TaskAudience,
	members: readonly TaskMember[],
	groups: readonly TaskGroup[],
	viewerId: string | null
): TaskMember[] {
	let allowed: TaskMember[];
	if (audience.visibility === 'private') {
		allowed = members.filter((member) => member.userId === viewerId);
	} else if (audience.visibility === 'everyone') {
		allowed = [...members];
	} else {
		const group = groups.find((g) => g._id === audience.groupId);
		const inGroup = new Set(group?.memberUserIds ?? []);
		allowed = members.filter((member) => inGroup.has(member.userId));
	}
	return allowed.sort((a, b) => {
		if (a.userId === viewerId) return -1;
		if (b.userId === viewerId) return 1;
		return memberSortName(a).localeCompare(memberSortName(b));
	});
}

function memberSortName(member: TaskMember): string {
	return (member.name?.trim() || member.email).toLowerCase();
}

/**
 * The assignee to keep after the audience changes: the chosen one while the
 * new audience allows them, else the viewer.
 */
export function taskAssigneeAfterAudience(
	audience: TaskAudience,
	assigneeUserId: string,
	members: readonly TaskMember[],
	groups: readonly TaskGroup[],
	viewerId: string
): string {
	if (audience.visibility === 'private') return viewerId;
	const options = taskAssigneeOptions(audience, members, groups, viewerId);
	// While the roster is still loading, an Everyone task keeps its assignee.
	if (audience.visibility === 'everyone' && members.length === 0) return assigneeUserId;
	return options.some((member) => member.userId === assigneeUserId) ? assigneeUserId : viewerId;
}

/** Whether the viewer may make this task private (they created it and own it). */
export function taskMayBecomePrivate(
	task: Pick<TaskView, 'createdBy' | 'assigneeUserId' | 'visibility'>,
	viewerId: string | null
): boolean {
	if (task.visibility === 'private') return true;
	return viewerId !== null && task.createdBy === viewerId && task.assigneeUserId === viewerId;
}

/**
 * Where a task's source conversation opens, or null when the viewer cannot
 * open it. The same routes as the Workbench (`threadHref` in utils/todayPeek.ts):
 * a Postbox thread by its newest message, a Team Inbox thread by its id.
 */
export function taskSourceHref(source: TaskSource | null): string | null {
	if (!source || !source.canOpen) return null;
	if (source.kind === 'team') return `/dashboard/inbox/${source.conversationThreadId}`;
	if (!source.messageId) return null;
	return `/dashboard/postbox/inbox/${source.messageId}?mailbox=${source.mailboxId}`;
}

export const TASK_LIST_VIEWS: readonly TaskListView[] = [
	'mine',
	'everyone',
	'group',
	'private',
	'created',
	'done',
];

export interface TaskPageView {
	view: TaskListView;
	groupId: Id<'memberGroups'> | null;
}

/** The list a `?view=` / `?group=` pair names; Mine for anything it does not recognise. */
export function parseTaskPageView(view: unknown, group: unknown): TaskPageView {
	const name = typeof view === 'string' ? view : '';
	if (!(TASK_LIST_VIEWS as readonly string[]).includes(name))
		return { view: 'mine', groupId: null };
	if (name === 'group') {
		return typeof group === 'string' && group
			? { view: 'group', groupId: group as Id<'memberGroups'> }
			: { view: 'mine', groupId: null };
	}
	return { view: name as TaskListView, groupId: null };
}

/** The tab key of a list: the view name, or `group:<id>` for a group's list. */
export function taskPageViewKey(view: TaskPageView): string {
	return view.view === 'group' && view.groupId ? `group:${view.groupId}` : view.view;
}

/** The audience quick add starts with on a list: the list's own audience where it has one. */
export function taskDefaultAudience(view: TaskPageView): TaskAudience {
	if (view.view === 'everyone') return { visibility: 'everyone' };
	if (view.view === 'group' && view.groupId) return { visibility: 'group', groupId: view.groupId };
	return TASK_PRIVATE_AUDIENCE;
}

/** Whether a new open task with this audience and owner shows in the list being viewed. */
export function taskShowsInView(
	view: TaskPageView,
	audience: TaskAudience,
	assigneeUserId: string,
	viewerId: string
): boolean {
	switch (view.view) {
		case 'mine':
			return assigneeUserId === viewerId;
		case 'everyone':
			return audience.visibility === 'everyone';
		case 'group':
			return audience.visibility === 'group' && audience.groupId === view.groupId;
		case 'private':
			return audience.visibility === 'private';
		case 'created':
			return assigneeUserId !== viewerId;
		case 'done':
			return false;
	}
}
