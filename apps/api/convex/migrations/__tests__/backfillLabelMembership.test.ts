/**
 * Migration 0074: every (message, label) pair of mail stored before the label
 * rows were maintained gets its `mailLabelMessages` row, each mailbox is marked
 * ready once its walk is done, and the pass completes only when every mailbox
 * is. A pair already stored is not written twice.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import {
	modules,
	seedFolder,
	seedMailbox,
	seedMessage,
} from '../../mail/__tests__/helpers.testlib';
import { MESSAGES_PER_PAGE, MIGRATION } from '../0074_backfill_label_membership';
import { isLabelMembershipReady } from '../../mail/labelMessageIndex';

const migration = internal.migrations[MIGRATION];

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe('0074_backfill_label_membership', () => {
	it('adds every pair, mailbox by mailbox over several pages, and marks each ready', async () => {
		const t = convexTest(schema, modules);
		const big = await seedMailbox(t, { address: 'big@owlat.test' });
		const small = await seedMailbox(t, { address: 'small@owlat.test' });
		await seedFolder(t, big);
		await seedFolder(t, small);
		const labelIn = async (mailboxId: Id<'mailboxes'>, name: string) =>
			await t.run((ctx) => ctx.db.insert('mailLabels', { mailboxId, name, createdAt: 0 }));
		const work = await labelIn(big, 'Work');
		const home = await labelIn(big, 'Home');
		const other = await labelIn(small, 'Other');

		const labeled: Array<[Id<'mailMessages'>, Id<'mailLabels'>[]]> = [];
		for (let i = 0; i < MESSAGES_PER_PAGE + 5; i++) {
			const id = await seedMessage(t, big, { subject: `big ${i}`, receivedAt: 1_000 + i });
			const labels = i % 10 === 0 ? [work, home] : i % 3 === 0 ? [work] : [];
			await t.run((ctx) => ctx.db.patch(id, { labelIds: labels }));
			if (labels.length > 0) labeled.push([id, labels]);
		}
		const smallId = await seedMessage(t, small, { subject: 'small' });
		await t.run((ctx) => ctx.db.patch(smallId, { labelIds: [other] }));
		labeled.push([smallId, [other]]);
		await t.mutation(migration.run, {});
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		await t.run(async (ctx) => {
			for (const [messageId, labels] of labeled) {
				const rows = await ctx.db
					.query('mailLabelMessages')
					.withIndex('by_message_and_label', (q) => q.eq('messageId', messageId))
					.collect();
				expect(rows.map((row) => row.labelId).sort()).toEqual([...labels].sort());
			}
			expect(await isLabelMembershipReady(ctx.db, big)).toBe(true);
			expect(await isLabelMembershipReady(ctx.db, small)).toBe(true);
			const run = await ctx.db
				.query('migrationRuns')
				.withIndex('by_migration', (q) => q.eq('migration', MIGRATION))
				.unique();
			const pairs = labeled.reduce((sum, [, labels]) => sum + labels.length, 0);
			expect(run).toMatchObject({ status: 'completed', changedCount: pairs });
			expect(run!.pageCount).toBeGreaterThan(2);
		});

		expect(await t.mutation(migration.run, {})).toMatchObject({ started: false });
		// A restart over ready mailboxes writes nothing.
		await t.mutation(migration.run, { restart: true });
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		await t.run(async (ctx) => {
			const run = await ctx.db
				.query('migrationRuns')
				.withIndex('by_migration', (q) => q.eq('migration', MIGRATION))
				.unique();
			expect(run).toMatchObject({ status: 'completed', changedCount: 0 });
		});
	});

	it('does not double a pair a label write stored before the walk', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId);
		const work = await t.run((ctx) =>
			ctx.db.insert('mailLabels', { mailboxId, name: 'Work', createdAt: 0 })
		);
		const messageId = await seedMessage(t, mailboxId, { subject: 'early' });
		await t.run(async (ctx) => {
			await ctx.db.patch(messageId, { labelIds: [work] });
			const message = (await ctx.db.get(messageId))!;
			await ctx.db.insert('mailLabelMessages', {
				mailboxId,
				labelId: work,
				messageId,
				threadId: message.threadId,
				receivedAt: message.receivedAt,
			});
		});

		await t.mutation(migration.run, {});
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		const rows = await t.run((ctx) =>
			ctx.db
				.query('mailLabelMessages')
				.withIndex('by_message_and_label', (q) => q.eq('messageId', messageId))
				.collect()
		);
		expect(rows).toHaveLength(1);
	});
});
