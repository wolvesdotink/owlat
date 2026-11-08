/**
 * The demo seed's groups, tasks and company index (`seedDemo/work.ts`): after
 * the fixture mail is delivered, every fixture task lands with its group and
 * its source conversation, the company index holds the companies of that mail
 * and not the free-mail sender, and a re-run inserts nothing twice.
 */

import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { components, internal } from '../_generated/api';
import { seedFolder, seedMailbox } from '../mail/__tests__/helpers.testlib';
import groupsFixture from '../seedDemo/fixtures/memberGroups.json';
import messagesFixture from '../seedDemo/fixtures/mailboxMessages.json';
import tasksFixture from '../seedDemo/fixtures/tasks.json';
import { newBetterAuthHarness } from './testModules';

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

const PEOPLE = ['dev', 'taylor', 'jordan'] as const;
const SHARED = new Set(['team@demo.localhost', 'support@demo.localhost']);

describe('seedDemo.work.seedWork', () => {
	it('seeds groups, linked tasks and the company index once', async () => {
		const t = newBetterAuthHarness();
		rateLimiterTest.register(t);
		const userIds: Record<string, string> = {};
		for (const person of PEOPLE) {
			const user = (await t.mutation(components.betterAuth.adapter.create, {
				input: {
					model: 'user',
					data: {
						name: person,
						email: `${person}@example.com`,
						emailVerified: true,
						createdAt: Date.now(),
						updatedAt: Date.now(),
					},
				},
			} as never)) as { _id: string };
			userIds[person] = user._id;
		}
		for (const address of new Set(messagesFixture.map((message) => message.recipient))) {
			const local = address.split('@')[0] ?? '';
			const mailboxId = await seedMailbox(t, {
				address,
				domain: 'demo.localhost',
				userId: SHARED.has(address) ? userIds['dev'] : userIds[local],
				...(SHARED.has(address) ? { scope: 'shared' as const } : {}),
			});
			await seedFolder(t, mailboxId);
		}
		await t.action(internal.seedDemo.messages.seedMailboxMessages, {});

		const first = await t.mutation(internal.seedDemo.work.seedWork, {});
		expect(first.groups).toBe(groupsFixture.length);
		expect(first.tasks).toBe(tasksFixture.length);

		await t.run(async (ctx) => {
			const tasks = await ctx.db.query('tasks').collect();
			for (const fixture of tasksFixture) {
				const task = tasks.find((row) => row.title === fixture.title);
				expect(task, fixture.title).toBeDefined();
				if (fixture.source) expect(task?.sourceMailThreadId, fixture.title).toBeDefined();
				if (fixture.visibility === 'group') expect(task?.groupId, fixture.title).toBeDefined();
			}

			const rows = await ctx.db.query('companyThreads').collect();
			const keys = new Set(rows.map((row) => row.companyKey));
			expect([...keys].sort()).toEqual([
				'acmecorp.example',
				'globex.example',
				'initech.example',
				'northwind.example',
			]);
			// Taylor's own Northwind mail: what tells Dev that Taylor is in touch.
			expect(
				rows.some(
					(row) => row.companyKey === 'northwind.example' && row.ownerUserId === userIds['taylor']
				)
			).toBe(true);
		});

		const again = await t.mutation(internal.seedDemo.work.seedWork, {});
		expect(again).toMatchObject({ groups: 0, tasks: 0 });
		expect(await t.run(async (ctx) => (await ctx.db.query('tasks').collect()).length)).toBe(
			tasksFixture.length
		);
	});
});
