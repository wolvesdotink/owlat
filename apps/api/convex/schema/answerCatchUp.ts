import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { catchUpValidator } from '../lib/validators/catchUp';

/**
 * RETIRED (ADR-0072): Answer mode's catch-up card, cached per thread and
 * interface locale. The thread brief replaced it; nothing writes or serves a
 * row any more. The table stays for one release so its rows still validate,
 * migration 0067 empties it, and the next release drops it
 * (`mail/legacySummaryRows.ts`). Until then erasure and thread deletion keep
 * deleting its rows, which retell the thread's mail.
 *
 * One row per (thread, locale); exactly one of `mailThreadId` /
 * `conversationThreadId` is set.
 */
export const answerCatchUpTables = {
	threadCatchUps: defineTable({
		mailThreadId: v.optional(v.id('mailThreads')),
		conversationThreadId: v.optional(v.id('conversationThreads')),
		mode: v.union(v.literal('full'), v.literal('asksOnly')),
		...catchUpValidator.fields,
	})
		.index('by_mail_thread_and_locale', ['mailThreadId', 'locale'])
		.index('by_conversation_thread_and_locale', ['conversationThreadId', 'locale']),
};
