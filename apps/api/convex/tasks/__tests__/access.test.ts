import { describe, expect, it } from 'vitest';
import { canSeeTask, checkTaskAudience, mayMakePrivate, type TaskViewer } from '../access';

const viewer = (userId: string, groups: string[] = []): TaskViewer => ({
	userId,
	groupIds: new Set(groups),
});

describe('canSeeTask', () => {
	it('shows a private task to its creator only', () => {
		const task = { visibility: 'private' as const, createdBy: 'ada', assigneeUserId: 'ada' };
		expect(canSeeTask(task, viewer('ada'))).toBe(true);
		expect(canSeeTask(task, viewer('ben'))).toBe(false);
		expect(canSeeTask(task, viewer('ben', ['management']))).toBe(false);
	});

	it('shows an everyone task to every member', () => {
		const task = { visibility: 'everyone' as const, createdBy: 'ada', assigneeUserId: 'ada' };
		expect(canSeeTask(task, viewer('ben'))).toBe(true);
	});

	it('shows a group task to its members and hides it from everyone else', () => {
		const task = {
			visibility: 'group' as const,
			groupId: 'management',
			createdBy: 'ada',
			assigneeUserId: 'cy',
		};
		expect(canSeeTask(task, viewer('dee', ['management']))).toBe(true);
		expect(canSeeTask(task, viewer('ben', ['support']))).toBe(false);
		expect(canSeeTask(task, viewer('ben'))).toBe(false);
	});

	it('keeps a group task visible to its creator and assignee after they leave the group', () => {
		const task = {
			visibility: 'group' as const,
			groupId: 'management',
			createdBy: 'ada',
			assigneeUserId: 'cy',
		};
		expect(canSeeTask(task, viewer('ada'))).toBe(true);
		expect(canSeeTask(task, viewer('cy'))).toBe(true);
	});
});

describe('checkTaskAudience', () => {
	it('refuses a private task assigned to someone else', () => {
		expect(
			checkTaskAudience({ visibility: 'private', assigneeUserId: 'ben' }, viewer('ada'), false)
		).toEqual({ ok: false, reason: 'private_assigned_to_other' });
		expect(
			checkTaskAudience({ visibility: 'private', assigneeUserId: 'ada' }, viewer('ada'), false)
		).toEqual({ ok: true });
	});

	it('refuses a group the actor is not in', () => {
		expect(
			checkTaskAudience(
				{ visibility: 'group', groupId: 'management', assigneeUserId: 'ada' },
				viewer('ada', ['support']),
				true
			)
		).toEqual({ ok: false, reason: 'not_in_viewer_group' });
	});

	it('refuses an assignee outside the group', () => {
		expect(
			checkTaskAudience(
				{ visibility: 'group', groupId: 'management', assigneeUserId: 'ben' },
				viewer('ada', ['management']),
				false
			)
		).toEqual({ ok: false, reason: 'assignee_outside_group' });
	});

	it('requires a group for a group task and none otherwise', () => {
		expect(
			checkTaskAudience({ visibility: 'group', assigneeUserId: 'ada' }, viewer('ada'), true)
		).toEqual({ ok: false, reason: 'group_missing' });
		expect(
			checkTaskAudience(
				{ visibility: 'everyone', groupId: 'management', assigneeUserId: 'ada' },
				viewer('ada', ['management']),
				true
			)
		).toEqual({ ok: false, reason: 'group_not_allowed' });
	});
});

describe('mayMakePrivate', () => {
	it('lets only someone who is both creator and assignee make a task private', () => {
		expect(
			mayMakePrivate({ visibility: 'everyone', createdBy: 'ada', assigneeUserId: 'ada' }, 'ada')
		).toBe(true);
		expect(
			mayMakePrivate({ visibility: 'everyone', createdBy: 'ben', assigneeUserId: 'ada' }, 'ada')
		).toBe(false);
		expect(
			mayMakePrivate({ visibility: 'everyone', createdBy: 'ada', assigneeUserId: 'ben' }, 'ada')
		).toBe(false);
	});
});
