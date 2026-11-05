/**
 * The pickers' half of the task audience rules: who a task may be assigned to
 * for each audience, what happens to the assignee when the audience changes,
 * who may make a task private, where a source conversation opens, and which
 * list the URL names.
 */
import { describe, expect, it } from 'vitest';
import type { TaskGroup, TaskMember } from '~/types/tasks';
import {
	parseTaskAudienceKey,
	parseTaskPageView,
	taskAssigneeAfterAudience,
	taskAssigneeOptions,
	taskAudienceGroups,
	taskAudienceKey,
	taskMayBecomePrivate,
	taskShowsInView,
	taskSourceHref,
} from '../taskAudience';

const member = (userId: string, name: string): TaskMember => ({
	userId,
	name,
	email: `${userId}@owlat.example`,
	image: null,
});
const members = [member('me', 'Mia'), member('bo', 'Bo'), member('ada', 'Ada')];
const groups = [
	{ _id: 'g1', name: 'Management', memberUserIds: ['me', 'ada'], isMember: true },
	{ _id: 'g2', name: 'Product', memberUserIds: ['bo'], isMember: false },
] as unknown as TaskGroup[];
const g1 = { visibility: 'group', groupId: 'g1' } as const;

describe('assignee options', () => {
	it('offers only the viewer for an Only me task', () => {
		const ids = taskAssigneeOptions({ visibility: 'private' }, members, groups, 'me');
		expect(ids.map((m) => m.userId)).toEqual(['me']);
	});

	it('offers everyone for an Everyone task, the viewer first, then by name', () => {
		const ids = taskAssigneeOptions({ visibility: 'everyone' }, members, groups, 'me');
		expect(ids.map((m) => m.userId)).toEqual(['me', 'ada', 'bo']);
	});

	it("offers a group task's group members only", () => {
		const ids = taskAssigneeOptions(g1 as never, members, groups, 'me');
		expect(ids.map((m) => m.userId)).toEqual(['me', 'ada']);
	});
});

describe('assignee after an audience change', () => {
	it('pins an Only me task to the viewer', () => {
		expect(taskAssigneeAfterAudience({ visibility: 'private' }, 'bo', members, groups, 'me')).toBe(
			'me'
		);
	});

	it('drops an assignee outside the new group', () => {
		expect(taskAssigneeAfterAudience(g1 as never, 'bo', members, groups, 'me')).toBe('me');
		expect(taskAssigneeAfterAudience(g1 as never, 'ada', members, groups, 'me')).toBe('ada');
	});

	it('keeps an Everyone assignee while the roster is still loading', () => {
		expect(taskAssigneeAfterAudience({ visibility: 'everyone' }, 'bo', [], groups, 'me')).toBe(
			'bo'
		);
	});
});

describe('audience choices', () => {
	it("lists the viewer's own groups, and a task's group the viewer has left", () => {
		expect(taskAudienceGroups(groups).map((g) => g.name)).toEqual(['Management']);
		const onProduct = { visibility: 'group', groupId: 'g2' } as never;
		expect(taskAudienceGroups(groups, onProduct).map((g) => g.name)).toEqual([
			'Management',
			'Product',
		]);
	});

	it('round-trips audience keys', () => {
		for (const audience of [{ visibility: 'private' }, { visibility: 'everyone' }, g1] as const) {
			expect(parseTaskAudienceKey(taskAudienceKey(audience as never))).toEqual(audience);
		}
		expect(parseTaskAudienceKey('group:')).toBeNull();
	});

	it('lets only the creator who also owns a task make it private', () => {
		const task = { visibility: 'everyone' as const, createdBy: 'me', assigneeUserId: 'me' };
		expect(taskMayBecomePrivate(task, 'me')).toBe(true);
		expect(taskMayBecomePrivate({ ...task, assigneeUserId: 'bo' }, 'me')).toBe(false);
		expect(taskMayBecomePrivate({ ...task, createdBy: 'bo' }, 'me')).toBe(false);
	});
});

describe('taskSourceHref', () => {
	it('opens a Postbox thread at its newest message, in its mailbox', () => {
		const source = {
			kind: 'mail',
			mailThreadId: 't1',
			mailboxId: 'mb1',
			messageId: 'm9',
			canOpen: true,
			subject: 'Renewal',
		} as never;
		expect(taskSourceHref(source)).toBe('/dashboard/postbox/inbox/m9?mailbox=mb1');
	});

	it('opens a Team Inbox thread by its id', () => {
		const source = { kind: 'team', conversationThreadId: 'c1', canOpen: true, subject: null };
		expect(taskSourceHref(source as never)).toBe('/dashboard/inbox/c1');
	});

	it('gives no link to a conversation the viewer cannot open', () => {
		const source = { kind: 'team', conversationThreadId: 'c1', canOpen: false, subject: null };
		expect(taskSourceHref(source as never)).toBeNull();
		expect(taskSourceHref(null)).toBeNull();
	});
});

describe('the list in the URL', () => {
	it('reads a view and a group, and falls back to Mine', () => {
		expect(parseTaskPageView('done', undefined)).toEqual({ view: 'done', groupId: null });
		expect(parseTaskPageView('group', 'g1')).toEqual({ view: 'group', groupId: 'g1' });
		expect(parseTaskPageView('group', undefined)).toEqual({ view: 'mine', groupId: null });
		expect(parseTaskPageView('nonsense', 'g1')).toEqual({ view: 'mine', groupId: null });
	});

	it('says whether a new task lands in the list being viewed', () => {
		const mine = { view: 'mine', groupId: null } as const;
		const created = { view: 'created', groupId: null } as const;
		expect(taskShowsInView(mine, { visibility: 'private' }, 'me', 'me')).toBe(true);
		expect(taskShowsInView(mine, { visibility: 'everyone' }, 'bo', 'me')).toBe(false);
		expect(taskShowsInView(created, { visibility: 'everyone' }, 'bo', 'me')).toBe(true);
		expect(
			taskShowsInView({ view: 'group', groupId: 'g1' } as never, g1 as never, 'ada', 'me')
		).toBe(true);
	});
});
