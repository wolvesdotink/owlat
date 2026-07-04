/**
 * Storage + context helpers for personal-mail draft-on-arrival (postbox.aiDraft).
 *
 * The Node action that actually calls the shared draft service lives in the
 * sibling `mail/draftOnArrival.ts` ('use node'); the v8-isolate query/mutation
 * halves live here so a single 'use node' file doesn't try to host a query.
 *
 * FAIL-SOFT posture: the loader returns `null` (skip drafting) for anything that
 * isn't a live, needs-a-reply personal-mail thread; the persister no-ops on a
 * stale trigger so a draft can never overwrite a newer message's slot.
 */

import { v } from 'convex/values';
import { internalQuery, internalMutation } from '../_generated/server';
import { draftQualityValidator } from '../lib/convexValidators';
import { NEEDS_REPLY_CONTEXT_MESSAGES } from './needsReply';

/** Cap each message excerpt fed into the draft context. */
const EXCERPT_CHARS = 2000;
/** Cap the assembled transcript. */
const CONTEXT_CHARS = 12000;

/**
 * Load everything the draft-on-arrival action needs for one thread, or `null`
 * when the thread should NOT be drafted (no needs-reply flag, inactive mailbox,
 * missing trigger message). Builds the untrusted transcript server-side so the
 * Node action never handles raw message docs.
 */
export const loadForDraft = internalQuery({
	args: { threadId: v.id('mailThreads') },
	handler: async (ctx, args) => {
		const thread = await ctx.db.get(args.threadId);
		if (!thread) return null;
		const flag = thread.needsReply;
		if (!flag) return null; // nothing flagged for reply → nothing to draft

		const mailbox = await ctx.db.get(thread.mailboxId);
		if (!mailbox || mailbox.status !== 'active') return null;

		const trigger = await ctx.db.get(flag.messageId);
		if (!trigger) return null;

		const all = await ctx.db
			.query('mailMessages')
			.withIndex('by_thread', (q) => q.eq('threadId', args.threadId))
			.collect();
		const newest = all
			.sort((a, b) => a.receivedAt - b.receivedAt)
			.slice(-NEEDS_REPLY_CONTEXT_MESSAGES);

		const transcript = newest
			.map((m) => {
				const body = (m.textBodyInline ?? m.snippet ?? '').slice(0, EXCERPT_CHARS);
				return `From: ${m.fromName || m.fromAddress}\nSubject: ${m.subject}\n${body}`;
			})
			.join('\n\n---\n\n')
			.slice(0, CONTEXT_CHARS);

		// Confirmed-owner facts from the clarification loop (only the ANSWERED
		// questions; unanswered questions carry no confirmed block). Shape matches
		// the shared buildConfirmedContext() consumer.
		const clarificationQuestions =
			flag.clarification && flag.clarification.answeredAt !== undefined
				? flag.clarification.questions.map((q) => ({
						text: q.text,
						answer: q.answer ? { value: q.answer.value } : undefined,
					}))
				: undefined;

		return {
			context: transcript,
			triggerMessageId: flag.messageId,
			triggerSubject: trigger.subject,
			mailboxId: thread.mailboxId,
			// Stale guard the persister re-checks: a newer inbound moves this.
			latestMessageId: thread.latestMessageId,
			urgency: flag.urgency,
			// person vs newsletter — the personal-mail taxonomy. Aligned to the
			// shared draft block's vocabulary in the action.
			isBulk: trigger.unsubscribe !== undefined,
			clarificationQuestions,
		};
	},
});

/**
 * Persist a generated review slot onto the thread's needs-reply flag. Guarded:
 * skips silently if the flag is gone or now points at a different (newer)
 * trigger message — the draft was for a message that is no longer current, so
 * writing it would surface a stale reply. Never clears the rest of the flag.
 */
export const persistDraftSlot = internalMutation({
	args: {
		threadId: v.id('mailThreads'),
		triggerMessageId: v.id('mailMessages'),
		draft: v.string(),
		draftSubject: v.optional(v.string()),
		confidence: v.number(),
		quality: v.optional(draftQualityValidator),
		options: v.optional(v.array(v.string())),
	},
	handler: async (ctx, args) => {
		const thread = await ctx.db.get(args.threadId);
		if (!thread || !thread.needsReply) return;
		// Stale guard: only attach to the trigger we drafted for.
		if (thread.needsReply.messageId !== args.triggerMessageId) return;

		await ctx.db.patch(args.threadId, {
			needsReply: {
				...thread.needsReply,
				draftSlot: {
					draft: args.draft,
					...(args.draftSubject ? { draftSubject: args.draftSubject } : {}),
					confidence: args.confidence,
					...(args.quality ? { quality: args.quality } : {}),
					...(args.options && args.options.length > 0 ? { options: args.options } : {}),
					generatedAt: Date.now(),
				},
			},
			updatedAt: Date.now(),
		});
	},
});
