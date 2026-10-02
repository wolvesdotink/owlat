import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import { modules } from '../../__tests__/testModules';
import type { Id } from '../../_generated/dataModel';

const MIGRATION = '0060_saved_reply_scopes';
const migration = internal.migrations[MIGRATION];

type Harness = TestConvex<typeof schema>;

async function seedMailbox(
	t: Harness,
	userId: string,
	scope?: 'shared' | 'seed'
): Promise<Id<'mailboxes'>> {
	return t.run((ctx) => {
		const now = Date.now();
		return ctx.db.insert('mailboxes', {
			userId,
			organizationId: 'org-1',
			address: `${userId}-${scope ?? 'personal'}@owlat.test`,
			domain: 'owlat.test',
			...(scope ? { scope } : {}),
			status: 'active',
			usedBytes: 0,
			uidValidity: now,
			createdAt: now,
			updatedAt: now,
		});
	});
}

async function seedLegacy(t: Harness, mailboxId: Id<'mailboxes'>, count = 1) {
	return t.run(async (ctx) => {
		const ids: Id<'mailSnippets'>[] = [];
		for (let i = 0; i < count; i++) {
			ids.push(
				await ctx.db.insert('mailSnippets', {
					mailboxId,
					name: `snippet ${i}`,
					shortcut: `s${i}`,
					bodyHtml: '<p>x</p>',
					createdAt: 1,
					updatedAt: 1,
				})
			);
		}
		return ids;
	});
}

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe('0060_saved_reply_scopes', () => {
	it('scopes every legacy row through its mailbox, over several pages', async () => {
		const t = convexTest(schema, modules);
		const personal = await seedMailbox(t, 'user-A');
		const team = await seedMailbox(t, 'admin-1', 'shared');
		const seed = await seedMailbox(t, 'admin-1', 'seed');
		const personalRows = await seedLegacy(t, personal, 60);
		const [teamRow] = await seedLegacy(t, team);
		const [seedRow] = await seedLegacy(t, seed);
		const alreadyScoped = await t.run((ctx) =>
			ctx.db.insert('mailSnippets', {
				scope: 'personal',
				ownerUserId: 'user-B',
				name: 'new',
				shortcut: '',
				bodyHtml: '<p>x</p>',
				createdAt: 1,
				updatedAt: 1,
			})
		);

		await t.mutation(migration.run, {});
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		await t.run(async (ctx) => {
			for (const id of personalRows) {
				expect(await ctx.db.get(id)).toMatchObject({
					scope: 'personal',
					ownerUserId: 'user-A',
					mailboxId: personal,
				});
			}
			expect(await ctx.db.get(teamRow!)).toMatchObject({
				scope: 'shared',
				organizationId: 'org-1',
				mailboxIds: [team],
				mailboxId: team,
			});
			// A seed is nobody's inbox: its row keeps no scope and shows nowhere.
			expect((await ctx.db.get(seedRow!))?.scope).toBeUndefined();
			expect(await ctx.db.get(alreadyScoped)).toMatchObject({ ownerUserId: 'user-B' });
			const run = await ctx.db
				.query('migrationRuns')
				.withIndex('by_migration', (q) => q.eq('migration', MIGRATION))
				.unique();
			expect(run).toMatchObject({ status: 'completed', changedCount: 61 });
		});

		// Finished: a second run does nothing.
		expect(await t.mutation(migration.run, {})).toMatchObject({ started: false });
	});
});
