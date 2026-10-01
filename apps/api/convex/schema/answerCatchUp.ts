import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { catchUpValidator } from '../lib/validators/catchUp';

/**
 * Answer mode's catch-up card, cached per thread and interface locale
 * (mail/ai/catchUp.ts for Postbox threads, inbox/catchUp.ts for team threads).
 *
 * One row per (thread, locale). Exactly one of `mailThreadId` /
 * `conversationThreadId` is set. The row is served only while its
 * `messageCount` matches the thread's live count, so a new message makes it
 * stale and the next open regenerates it in place.
 *
 * `mode` records what was asked of the model: a thread worth a summary gets the
 * full card (`full`), a short one only its asks (`asksOnly`, `sentences` empty),
 * which is cached too so a short email is not re-read on every open just to
 * learn it has one ask. Derived from the thread's content, so it goes with the
 * tenant and with the thread; it names no reader.
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
