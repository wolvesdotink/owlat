/**
 * Storage + context helpers for personal-mail draft-on-arrival (postbox.aiDraft).
 *
 * The Node action that actually calls the shared draft service lives in the
 * sibling `mail/ai/draftOnArrival.ts` ('use node'); the v8-isolate query/mutation
 * halves live here so a single 'use node' file doesn't try to host a query.
 *
 * FAIL-SOFT posture: the loader returns `null` (skip drafting) for anything that
 * isn't a live, needs-a-reply personal-mail thread whose trigger someone ELSE
 * sent and the owner has not answered yet; the persister no-ops on a
 * stale trigger so a draft can never overwrite a newer message's slot.
 */

import { v } from 'convex/values';
import { openMailMessageInlineBody } from '../../lib/messageBody';
import { internalQuery, internalMutation } from '../../_generated/server';
import { draftQualityValidator } from '../../lib/convexValidators';
import { NEEDS_REPLY_CONTEXT_MESSAGES } from '../needsReply';
import { isFromMailboxOwner } from '../needsReplyHeuristic';
import type { Doc } from '../../_generated/dataModel';

/** Cap each message excerpt fed into the draft context. */
const EXCERPT_CHARS = 2000;
/** Cap the assembled transcript. */
const CONTEXT_CHARS = 12000;
/** Heads the message the draft answers — always the last one in the transcript. */
const TRIGGER_MARKER = '=== The message to reply to ===';

/**
 * Load everything the draft-on-arrival action needs for one thread, or `null`
 * when the thread should NOT be drafted (no needs-reply flag, inactive mailbox,
 * missing trigger message, a trigger the owner wrote, or an owner reply after
 * it). Builds the untrusted transcript server-side so the
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

		// Bounded read: the `by_thread` index is ordered by _creationTime, so
		// `order('desc').take(N)` pulls only the newest N docs off the index
		// instead of scanning the whole thread (no unbounded collect).
		const newestDesc = await ctx.db
			.query('mailMessages')
			.withIndex('by_thread', (q) => q.eq('threadId', args.threadId))
			.order('desc')
			.take(NEEDS_REPLY_CONTEXT_MESSAGES);

		// Only ever answer mail someone else sent us. A trigger we wrote, or a
		// reply of ours that already followed it, means there is nothing to
		// answer — drafting anyway produces a reply to our own message.
		const ownerAddress = mailbox.address;
		if (isFromMailboxOwner(trigger, ownerAddress)) return null;
		if (
			newestDesc.some(
				(m) => isFromMailboxOwner(m, ownerAddress) && m.receivedAt >= trigger.receivedAt
			)
		) {
			return null;
		}

		// Chronological history up to the trigger, then the trigger itself LAST
		// and marked, with every message labelled by side. Without the labels the
		// model cannot tell our messages from theirs and happily drafts the other
		// party's answer to what we wrote.
		const history = newestDesc
			.filter((m) => m._id !== trigger._id && m.receivedAt <= trigger.receivedAt)
			.sort((a, b) => a.receivedAt - b.receivedAt);
		const render = async (m: Doc<'mailMessages'>) => {
			const body = ((await openMailMessageInlineBody(m)).text ?? m.snippet ?? '').slice(
				0,
				EXCERPT_CHARS
			);
			const sender = m.fromName ? `${m.fromName} <${m.fromAddress}>` : m.fromAddress;
			const side = isFromMailboxOwner(m, ownerAddress)
				? 'the mailbox owner (you)'
				: 'the other party';
			return `From: ${sender} — ${side}\nSubject: ${m.subject}\n${body}`;
		};
		const earlier = await Promise.all(history.map(render));
		const latest = `${TRIGGER_MARKER}\n${await render(trigger)}`;
		// Trim the OLDEST history first so the message being answered always fits.
		let transcript = [...earlier, latest].join('\n\n---\n\n');
		while (transcript.length > CONTEXT_CHARS && earlier.length > 0) {
			earlier.shift();
			transcript = [...earlier, latest].join('\n\n---\n\n');
		}
		transcript = transcript.slice(0, CONTEXT_CHARS);

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
			ownerAddress,
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
