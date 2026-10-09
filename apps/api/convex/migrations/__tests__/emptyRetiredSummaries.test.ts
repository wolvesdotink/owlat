/**
 * Migration 0067: the retired thread summaries' stores are emptied, the
 * catch-up cards and Today sentences deleted and `mailThreads.summaryCache`
 * cleared, over several pages and resumable from the ledger.
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
import { MIGRATION, decodeCursor, encodeCursor, nextPass } from '../0067_empty_retired_summaries';

const migration = internal.migrations[MIGRATION];

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe('cursor', () => {
	it('round-trips each pass and starts at the catch-up cards', () => {
		expect(decodeCursor(null)).toEqual({ pass: 'catchUps', cursor: null });
		expect(decodeCursor(encodeCursor('threads', 'abc'))).toEqual({
			pass: 'threads',
			cursor: 'abc',
		});
		expect(decodeCursor(encodeCursor('todaySummaries', null))).toEqual({
			pass: 'todaySummaries',
			cursor: null,
		});
		expect(nextPass('catchUps')).toBe('todaySummaries');
		expect(nextPass('todaySummaries')).toBe('threads');
		expect(nextPass('threads')).toBeNull();
	});
});

describe('0067_empty_retired_summaries', () => {
	it('deletes every card and sentence and clears every summary cache', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId);
		const threadIds: Id<'mailThreads'>[] = [];
		for (let i = 0; i < 3; i++) {
			const messageId = await seedMessage(t, mailboxId, { subject: `s${i}` });
			threadIds.push(await t.run(async (ctx) => (await ctx.db.get(messageId))!.threadId));
		}
		await t.run(async (ctx) => {
			for (const threadId of threadIds) {
				await ctx.db.patch(threadId, {
					summaryCache: { summary: 'old', messageCount: 1, generatedAt: 1 },
				});
			}
			// More rows than one page of each table.
			for (let i = 0; i < 230; i++) {
				await ctx.db.insert('threadCatchUps', {
					mailThreadId: threadIds[i % 3]!,
					mode: 'asksOnly',
					locale: `l${i}`,
					messageCount: 1,
					sentences: [],
					asks: [],
					generatedAt: 1,
				});
				await ctx.db.insert('todayThreadSummaries', {
					threadId: threadIds[i % 3]!,
					locale: 'en',
					messageCount: i,
					sinceCount: 0,
					sentence: 'Ana asked for the invoice.',
					generatedAt: 1,
				});
			}
		});

		await t.mutation(migration.run, {});
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		await t.run(async (ctx) => {
			expect(await ctx.db.query('threadCatchUps').first()).toBeNull();
			expect(await ctx.db.query('todayThreadSummaries').first()).toBeNull();
			for (const threadId of threadIds) {
				const thread = (await ctx.db.get(threadId))!;
				expect(thread.summaryCache).toBeUndefined();
				expect(thread.latestSubject).toBeDefined();
			}
			const run = await ctx.db
				.query('migrationRuns')
				.withIndex('by_migration', (q) => q.eq('migration', MIGRATION))
				.first();
			expect(run?.status).toBe('completed');
		});

		// A finished walk is left alone.
		expect(await t.mutation(migration.run, {})).toMatchObject({ started: false });
	});
});
