/**
 * Who may see and change a task. Pure: the handlers load the task, the
 * viewer's group memberships and the target group's members, then ask here.
 *
 * Seeing a task is what matters most, because a task title can carry
 * anything (a salary, a contract figure). The rules:
 *   - private: only the creator, who is also always its assignee;
 *   - everyone: every member of the workspace;
 *   - group: the group's members, and the task's creator and assignee even
 *     after they leave the group (their own work does not vanish from them).
 *     Owners and admins outside the group do not see it.
 *
 * Whoever sees a task may work on it: edit, assign within its audience,
 * complete, drop and restore it. Only the person a task is private to can
 * make it private; that check is `planVisibilityChange`.
 */

import type { TaskVisibility } from '../lib/validators/tasks';

export interface TaskAccessShape {
	visibility: TaskVisibility;
	groupId?: string;
	createdBy: string;
	assigneeUserId: string;
}

export interface TaskViewer {
	userId: string;
	/** The member groups the viewer belongs to. */
	groupIds: ReadonlySet<string>;
}

export function canSeeTask(task: TaskAccessShape, viewer: TaskViewer): boolean {
	if (task.createdBy === viewer.userId || task.assigneeUserId === viewer.userId) return true;
	switch (task.visibility) {
		case 'private':
			return false;
		case 'everyone':
			return true;
		case 'group':
			return task.groupId !== undefined && viewer.groupIds.has(task.groupId);
	}
}

/** What a task's audience would be after a change, and who would own it. */
export interface TaskAudienceRequest {
	visibility: TaskVisibility;
	groupId?: string;
	assigneeUserId: string;
}

export type TaskAudienceOutcome =
	| { ok: true }
	| {
			ok: false;
			reason:
				| 'private_assigned_to_other'
				| 'group_missing'
				| 'group_not_allowed'
				| 'not_in_viewer_group'
				| 'assignee_outside_group';
	  };

/**
 * Whether `actor` may give a task this audience and owner.
 *
 * - A private task belongs to one person: the actor, who must also be its
 *   assignee, so nobody can file a task privately for someone else.
 * - A group task needs a group, the actor must belong to it (no posting into
 *   a group you cannot read), and the assignee must belong to it too.
 * - An everyone task names no group.
 *
 * `assigneeGroupMember` answers whether the requested assignee is in the
 * requested group; it is only consulted for group tasks.
 */
export function checkTaskAudience(
	request: TaskAudienceRequest,
	actor: TaskViewer,
	assigneeGroupMember: boolean
): TaskAudienceOutcome {
	switch (request.visibility) {
		case 'private':
			if (request.groupId !== undefined) return { ok: false, reason: 'group_not_allowed' };
			if (request.assigneeUserId !== actor.userId) {
				return { ok: false, reason: 'private_assigned_to_other' };
			}
			return { ok: true };
		case 'everyone':
			if (request.groupId !== undefined) return { ok: false, reason: 'group_not_allowed' };
			return { ok: true };
		case 'group':
			if (request.groupId === undefined) return { ok: false, reason: 'group_missing' };
			if (!actor.groupIds.has(request.groupId)) {
				return { ok: false, reason: 'not_in_viewer_group' };
			}
			if (!assigneeGroupMember) return { ok: false, reason: 'assignee_outside_group' };
			return { ok: true };
	}
}

/**
 * Making a task private takes it away from everyone else, so only someone
 * who already holds all of it may do that: the actor must be both its
 * creator and its assignee. A task a colleague handed you stays visible to
 * them.
 */
export function mayMakePrivate(task: TaskAccessShape, actorUserId: string): boolean {
	return task.createdBy === actorUserId && task.assigneeUserId === actorUserId;
}

export const TASK_AUDIENCE_MESSAGES: Record<
	Exclude<TaskAudienceOutcome, { ok: true }>['reason'],
	string
> = {
	private_assigned_to_other: 'A private task can only be assigned to you.',
	group_missing: 'Choose the group that should see this task.',
	group_not_allowed: 'Only a group task names a group.',
	not_in_viewer_group: 'You can only share a task with a group you belong to.',
	assignee_outside_group: 'The assignee must belong to the group that sees this task.',
};
