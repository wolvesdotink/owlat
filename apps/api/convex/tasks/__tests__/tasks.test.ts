/**
 * Task visibility and audience rules through the real functions:
 *
 *   - a private task reaches no one but its creator, in every read, and reads
 *     as missing to anyone else's writes;
 *   - a group task reaches the group's members and stays hidden from an admin
 *     outside the group;
 *   - `create` refuses a private task for someone else and a group task whose
 *     assignee is outside the group; `update` refuses to make private a task
 *     someone else created or owns;
 *   - only owners and admins change groups, and a group with tasks cannot be
 *     deleted.
 */

import { describe, expect, it, vi } from 'vitest';
import { api } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { TASK_LIST_VIEWS } from '../tasks';
import { type Harness, seedMailbox, seedThread, workspaceHarness } from './fixtures.testlib';

const sessionMock = vi.hoisted(() => ({
	userId: 'user-dev',
	role: 'editor' as 'owner' | 'admin' | 'editor',
	orgId: 'org-1',
}));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	const session = () => ({
		userId: sessionMock.userId,
		role: sessionMock.role,
		activeOrganizationId: sessionMock.orgId,
	});
	return {
		...actual,
		requireOrgMember: vi.fn(async () => session()),
		getMutationContext: vi.fn(async () => session()),
		requireAdminContext: vi.fn(async () => {
			if (sessionMock.role === 'editor') throw new Error('Only owners and admins');
			return session();
		}),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getBetterAuthSessionWithRole: vi.fn(async () => session()),
	};
});

function as(userId: string, role: 'owner' | 'admin' | 'editor' = 'editor') {
	sessionMock.userId = userId;
	sessionMock.role = role;
}

const MEMBERS = {
	'user-dev': 'owner',
	'user-taylor': 'admin',
	'user-jordan': 'editor',
	'user-sam': 'editor',
};

async function setup(): Promise<Harness> {
	return await workspaceHarness(MEMBERS);
}

/** Every task id any read hands `userId` for this company and thread. */
async function everythingVisibleTo(
	t: Harness,
	userId: string,
	role: 'owner' | 'admin' | 'editor',
	scope: { companyKey: string; mailThreadId: Id<'mailThreads'> }
): Promise<string[]> {
	as(userId, role);
	const ids: string[] = [];
	for (const view of TASK_LIST_VIEWS) {
		for (const task of await t.query(api.tasks.tasks.list, { view })) ids.push(task._id);
	}
	for (const task of await t.query(api.tasks.tasks.forCompany, { companyKey: scope.companyKey })) {
		ids.push(task._id);
	}
	for (const task of await t.query(api.tasks.tasks.forThread, {
		mailThreadId: scope.mailThreadId,
	})) {
		ids.push(task._id);
	}
	return ids;
}

describe('private tasks', () => {
	it('never reach another member, whatever they read or try to change', async () => {
		const t = await setup();
		// A shared mailbox everyone in the test can open, so the thread itself
		// is readable and only the task's visibility decides.
		const teamBox = await seedMailbox(t, 'user-dev', 'team@owlat.test', {
			scope: 'shared',
			members: ['user-taylor', 'user-jordan'],
		});
		const threadId = await seedThread(t, teamBox, {
			participants: ['mia@northwind.example'],
			subject: 'Pricing for 40 seats',
		});
		as('user-dev');
		const taskId = await t.mutation(api.tasks.mutations.create, {
			title: 'Counter-offer 18% for Northwind',
			visibility: 'private',
			mailThreadId: threadId,
		});

		const scope = { companyKey: 'northwind.example', mailThreadId: threadId };
		const own = await everythingVisibleTo(t, 'user-dev', 'owner', scope);
		expect(own).toContain(taskId);
		for (const [userId, role] of [
			['user-taylor', 'admin'],
			['user-jordan', 'editor'],
		] as const) {
			expect(await everythingVisibleTo(t, userId, role, scope)).not.toContain(taskId);
			expect(await t.query(api.tasks.tasks.get, { taskId })).toBeNull();
			await expect(
				t.mutation(api.tasks.mutations.setStatus, { taskId, status: 'done' })
			).rejects.toThrow(/Task not found/);
			await expect(
				t.mutation(api.tasks.mutations.update, { taskId, title: 'Peeked' })
			).rejects.toThrow(/Task not found/);
		}

		// Finished, it stays out of everyone else's Done list too.
		as('user-dev', 'owner');
		await t.mutation(api.tasks.mutations.setStatus, { taskId, status: 'done' });
		as('user-taylor', 'admin');
		const done = await t.query(api.tasks.tasks.list, { view: 'done' });
		expect(done.map((task) => task._id)).not.toContain(taskId);
		const row = await t.run((ctx) => ctx.db.get(taskId));
		expect(row?.title).toBe('Counter-offer 18% for Northwind');
	});

	it('cannot be filed for someone else', async () => {
		const t = await setup();
		as('user-dev', 'owner');
		await expect(
			t.mutation(api.tasks.mutations.create, {
				title: 'Their secret',
				visibility: 'private',
				assigneeUserId: 'user-jordan',
			})
		).rejects.toThrow(/private task can only be assigned to you/);
	});

	it('can only be made private by the person who created and owns the task', async () => {
		const t = await setup();
		as('user-taylor', 'admin');
		const handedOver = await t.mutation(api.tasks.mutations.create, {
			title: 'Review the renewal',
			visibility: 'everyone',
			assigneeUserId: 'user-dev',
		});
		// Dev owns it now, but Taylor created it: Taylor would lose sight of it.
		as('user-dev', 'owner');
		await expect(
			t.mutation(api.tasks.mutations.update, { taskId: handedOver, visibility: 'private' })
		).rejects.toThrow(/Only a task you created and own yourself/);
		// Taylor created it, but Dev owns it: Dev would lose sight of it.
		as('user-taylor', 'admin');
		await expect(
			t.mutation(api.tasks.mutations.update, { taskId: handedOver, visibility: 'private' })
		).rejects.toThrow(/Only a task you created and own yourself/);

		as('user-jordan');
		const own = await t.mutation(api.tasks.mutations.create, {
			title: 'Tidy my notes',
			visibility: 'everyone',
		});
		await t.mutation(api.tasks.mutations.update, { taskId: own, visibility: 'private' });
		expect((await t.run((ctx) => ctx.db.get(own)))?.visibility).toBe('private');
	});
});

describe('tasks of a conversation', () => {
	it('are listed only beside a conversation the viewer can open', async () => {
		const t = await setup();
		const devBox = await seedMailbox(t, 'user-dev', 'dev@owlat.test');
		const threadId = await seedThread(t, devBox, { participants: ['sam@northwind.example'] });
		as('user-dev', 'owner');
		const taskId = await t.mutation(api.tasks.mutations.create, {
			title: 'Reply to Sam',
			visibility: 'everyone',
			mailThreadId: threadId,
		});
		const own = await t.query(api.tasks.tasks.forThread, { mailThreadId: threadId });
		expect(own.map((task) => task._id)).toEqual([taskId]);

		// Jordan sees the task in the shared lists, without its subject, but
		// cannot ask what hangs off a conversation in Dev's own mailbox.
		as('user-jordan');
		expect(await t.query(api.tasks.tasks.forThread, { mailThreadId: threadId })).toEqual([]);
		const view = await t.query(api.tasks.tasks.get, { taskId });
		expect(view?.source).toMatchObject({ kind: 'mail', canOpen: false, subject: null });
	});
});

describe('group tasks', () => {
	async function management(t: Harness): Promise<Id<'memberGroups'>> {
		as('user-dev', 'owner');
		return await t.mutation(api.tasks.groups.create, {
			name: 'Management',
			memberUserIds: ['user-dev', 'user-jordan'],
		});
	}

	it('reach the group’s members and stay hidden from an admin outside it', async () => {
		const t = await setup();
		const groupId = await management(t);
		as('user-jordan');
		const taskId = await t.mutation(api.tasks.mutations.create, {
			title: 'Decide on the price increase',
			visibility: 'group',
			groupId,
			assigneeUserId: 'user-dev',
		});

		as('user-dev', 'owner');
		const devGroup = await t.query(api.tasks.tasks.list, { view: 'group', groupId });
		expect(devGroup.map((task) => task._id)).toEqual([taskId]);
		expect(devGroup[0]?.groupName).toBe('Management');

		as('user-taylor', 'admin');
		expect(await t.query(api.tasks.tasks.get, { taskId })).toBeNull();
		expect(await t.query(api.tasks.tasks.list, { view: 'group', groupId })).toEqual([]);
		for (const view of TASK_LIST_VIEWS) {
			const ids = (await t.query(api.tasks.tasks.list, { view })).map((task) => task._id);
			expect(ids, view).not.toContain(taskId);
		}
		await expect(
			t.mutation(api.tasks.mutations.setStatus, { taskId, status: 'done' })
		).rejects.toThrow(/Task not found/);
	});

	it('cannot be assigned outside the group or posted into a group the creator is not in', async () => {
		const t = await setup();
		const groupId = await management(t);
		as('user-jordan');
		await expect(
			t.mutation(api.tasks.mutations.create, {
				title: 'Hire a second support person',
				visibility: 'group',
				groupId,
				assigneeUserId: 'user-taylor',
			})
		).rejects.toThrow(/assignee must belong to the group/);
		as('user-sam');
		await expect(
			t.mutation(api.tasks.mutations.create, {
				title: 'Sneak in',
				visibility: 'group',
				groupId,
			})
		).rejects.toThrow(/group you belong to/);
	});
});

describe('member groups', () => {
	it('are changed by owners and admins only', async () => {
		const t = await setup();
		as('user-jordan');
		await expect(
			t.mutation(api.tasks.groups.create, { name: 'Product', memberUserIds: ['user-jordan'] })
		).rejects.toThrow();
		as('user-taylor', 'admin');
		const groupId = await t.mutation(api.tasks.groups.create, {
			name: 'Product',
			memberUserIds: ['user-jordan'],
		});
		as('user-jordan');
		await expect(
			t.mutation(api.tasks.groups.addMember, { groupId, userId: 'user-sam' })
		).rejects.toThrow();
		await expect(t.mutation(api.tasks.groups.rename, { groupId, name: 'Mine' })).rejects.toThrow();
		await expect(t.mutation(api.tasks.groups.remove, { groupId })).rejects.toThrow();
		// Every member can see who a group task reaches.
		const groups = await t.query(api.tasks.groups.list, {});
		expect(groups).toEqual([
			{ _id: groupId, name: 'Product', memberUserIds: ['user-jordan'], isMember: true },
		]);
	});

	it('refuse to delete a group that still has tasks', async () => {
		const t = await setup();
		as('user-dev', 'owner');
		const groupId = await t.mutation(api.tasks.groups.create, {
			name: 'Management',
			memberUserIds: ['user-dev'],
		});
		const taskId = await t.mutation(api.tasks.mutations.create, {
			title: 'Board meeting agenda',
			visibility: 'group',
			groupId,
		});
		await expect(t.mutation(api.tasks.groups.remove, { groupId })).rejects.toThrow(
			/still has tasks/
		);
		expect(await t.run((ctx) => ctx.db.get(groupId))).not.toBeNull();

		await t.mutation(api.tasks.mutations.update, { taskId, visibility: 'everyone' });
		await t.mutation(api.tasks.groups.remove, { groupId });
		expect(await t.run((ctx) => ctx.db.get(groupId))).toBeNull();
	});
});

describe('finished tasks', () => {
	it('list done and dropped tasks under Done, so a dropped task can be restored', async () => {
		const t = await setup();
		as('user-dev', 'owner');
		const done = await t.mutation(api.tasks.mutations.create, {
			title: 'Send the contract',
			visibility: 'everyone',
		});
		const dropped = await t.mutation(api.tasks.mutations.create, {
			title: 'Plan the offsite',
			visibility: 'private',
		});
		await t.mutation(api.tasks.mutations.setStatus, { taskId: done, status: 'done' });
		await t.mutation(api.tasks.mutations.setStatus, { taskId: dropped, status: 'dropped' });

		const finished = await t.query(api.tasks.tasks.list, { view: 'done' });
		expect(finished.map((task) => [task._id, task.status]).sort()).toEqual(
			[
				[done, 'done'],
				[dropped, 'dropped'],
			].sort()
		);

		await t.mutation(api.tasks.mutations.setStatus, { taskId: dropped, status: 'open' });
		const mine = await t.query(api.tasks.tasks.list, { view: 'mine' });
		expect(mine.map((task) => task._id)).toContain(dropped);
	});
});
