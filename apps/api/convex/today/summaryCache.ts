/**
 * The cache behind Today's one-sentence summaries — the non-'use node' half of
 * today/summarize.ts (an action cannot write the database itself).
 *
 * A sentence is only ever served for the exact (thread, locale, message count,
 * since count) it was written for, so it can never describe a conversation
 * that has moved on since.
 */

import { v } from 'convex/values';
import type { Id } from '../_generated/dataModel';
import { internalMutation, type QueryCtx } from '../_generated/server';

export async function loadTodaySummary(
	ctx: QueryCtx,
	key: { threadId: Id<'mailThreads'>; locale: string; messageCount: number; sinceCount: number }
): Promise<string | null> {
	const row = await ctx.db
		.query('todayThreadSummaries')
		.withIndex('by_thread_locale_counts', (q) =>
			q
				.eq('threadId', key.threadId)
				.eq('locale', key.locale)
				.eq('messageCount', key.messageCount)
				.eq('sinceCount', key.sinceCount)
		)
		.first();
	return row?.sentence ?? null;
}

/** Store one sentence (idempotent per key; the newest write wins). */
export const store = internalMutation({
	args: {
		threadId: v.id('mailThreads'),
		locale: v.string(),
		messageCount: v.number(),
		sinceCount: v.number(),
		sentence: v.string(),
	},
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query('todayThreadSummaries')
			.withIndex('by_thread_locale_counts', (q) =>
				q
					.eq('threadId', args.threadId)
					.eq('locale', args.locale)
					.eq('messageCount', args.messageCount)
					.eq('sinceCount', args.sinceCount)
			)
			.first();
		const generatedAt = Date.now();
		if (existing) {
			await ctx.db.patch(existing._id, { sentence: args.sentence, generatedAt });
			return;
		}
		// Older sentences for the same thread + locale describe a conversation
		// that has since moved; drop them so the table stays one row per state.
		const stale = await ctx.db
			.query('todayThreadSummaries')
			.withIndex('by_thread_locale_counts', (q) =>
				q.eq('threadId', args.threadId).eq('locale', args.locale)
			)
			.take(20);
		for (const row of stale) {
			if (row.messageCount < args.messageCount) await ctx.db.delete(row._id);
		}
		await ctx.db.insert('todayThreadSummaries', { ...args, generatedAt });
	},
});
