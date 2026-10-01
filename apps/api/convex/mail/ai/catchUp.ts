'use node';

/**
 * Answer mode's catch-up card for a Postbox thread: a short retelling of the
 * thread with a source for every sentence, and the checklist of what the other
 * party is asking for, which the composer ticks off as the draft covers it.
 *
 * Opening Answer mode is an explicit signal that the user is about to reply, so
 * the card uses a lower bar than the reader's summary strip (`isCatchUpWorthy`:
 * 3+ messages or a long newest message; the strip keeps its own threshold). A
 * shorter thread still gets its asks, from the same call with the retelling
 * switched off, and they show once there are two or more.
 *
 * Gated like the strip (mail/ai/assist.ts getOrGenerateThreadSummary): the
 * caller must be able to read the thread, and a model call passes the `ai`
 * flag, the spend budget and a per-user rate limit first. A warm cache is
 * served without charging the gate. The thread is untrusted mail and reaches
 * the model only behind SYSTEM_GUARD (mail/ai/catchUpPrompt.ts).
 */

import { v } from 'convex/values';
import { htmlToPlainText } from '@owlat/shared/html';
import { isCatchUpWorthy } from '@owlat/shared/answerMode';
import { authedAction } from '../../lib/authedFunctions';
import { internal } from '../../_generated/api';
import type { Doc } from '../../_generated/dataModel';
import { openMailMessageInlineBody } from '../../lib/messageBody';
import { isFromMailboxOwner } from '../needsReplyHeuristic';
import { gateAndLoadThread } from './gate';
import { buildThreadTranscript, THREAD_SUMMARY } from './transcript';
import { checkAskCoverage, generateCatchUp } from './catchUpGenerate';
import {
	normalizeCatchUpLocale,
	visibleCatchUp,
	type CatchUp,
	type CatchUpEntry,
	type CatchUpMode,
} from './catchUpPrompt';

/** Plain-text length of a message body: the text part, else stripped HTML, else the snippet. */
async function plainBodyChars(message: Doc<'mailMessages'>): Promise<number> {
	const { text, html } = await openMailMessageInlineBody(message);
	if (text && text.trim()) return text.trim().length;
	if (html) return htmlToPlainText(html).length;
	return (message.snippet ?? '').length;
}

/**
 * The thread as labelled entries, oldest first. Each message goes through the
 * shared transcript builder on its own, so the body fallback and the side
 * labels are the ones every other Postbox AI feature uses.
 */
async function mailCatchUpEntries(
	messages: Doc<'mailMessages'>[],
	ownerAddress: string
): Promise<CatchUpEntry[]> {
	return Promise.all(
		messages.map(async (message, index) => ({
			label: `m${index + 1}`,
			messageId: message._id,
			side: isFromMailboxOwner(message, ownerAddress) ? ('owner' as const) : ('other' as const),
			text: await buildThreadTranscript([message], {
				...THREAD_SUMMARY,
				// One message: its body cap plus room for the From/Subject lines.
				totalChars: THREAD_SUMMARY.perMessageChars + 600,
				ownerAddress,
			}),
		}))
	);
}

// authz: the thread is read through mail.ai.catchUpStore.readForMessage and
// mail.mailbox.messages.listThreadMessages, both of which return null unless
// the caller can read the mailbox (loadReadableMailbox); org membership is
// enforced by authedAction; the `ai` flag, spend budget and per-user rate limit
// by aiGate.assertAiAllowed before any model call.
export const ensure = authedAction({
	args: { messageId: v.id('mailMessages'), locale: v.string() },
	handler: async (ctx, args): Promise<CatchUp | null> => {
		const locale = normalizeCatchUpLocale(args.locale);
		const state = await ctx.runQuery(internal.mail.ai.catchUpStore.readForMessage, {
			messageId: args.messageId,
			locale,
		});
		if (!state || !state.aiEnabled) return null;
		if (state.cached) return visibleCatchUp(state.cached);

		const thread = await gateAndLoadThread(ctx, args.messageId);
		if (!thread?.thread || thread.messages.length === 0) return null;
		const { messages } = thread;
		// The count the messages were read at, so a message landing meanwhile
		// leaves this card stale rather than mislabelled fresh.
		const messageCount = thread.thread.messageCount;
		const entries = await mailCatchUpEntries(messages, state.ownerAddress);
		const newest = messages[messages.length - 1]!;
		const newestInbound =
			[...messages].reverse().find((m) => !isFromMailboxOwner(m, state.ownerAddress)) ?? newest;
		const mode: CatchUpMode = isCatchUpWorthy(messageCount, await plainBodyChars(newestInbound))
			? 'full'
			: 'asksOnly';

		// A short thread with nothing from the other party has no asks to find:
		// cache that without a model call.
		const hasOtherParty = entries.some((e) => e.side === 'other');
		const result =
			mode === 'asksOnly' && !hasOtherParty
				? { sentences: [], asks: [] }
				: await generateCatchUp(ctx, { entries, mode, locale, feature: 'answer_catch_up' });
		if (!result) return null;

		const catchUp: CatchUp = { ...result, messageCount, locale, generatedAt: Date.now() };
		await ctx.runMutation(internal.mail.ai.catchUpStore.store, {
			mailThreadId: thread.thread._id,
			mode,
			catchUp,
		});
		return visibleCatchUp({ mode, ...catchUp });
	},
});

// authz: the card is read through mail.ai.catchUpStore.readForMessage, which
// returns null unless the caller can read the mailbox (loadReadableMailbox);
// org membership is enforced by authedAction; the `ai` flag, spend budget and a
// per-user rate limit (its own bucket) by aiGate.assertAiAllowed. The draft
// text is the caller's own.
export const coverage = authedAction({
	args: { messageId: v.id('mailMessages'), draftText: v.string(), locale: v.string() },
	handler: async (ctx, args): Promise<{ coveredAskIds: string[] }> => {
		const state = await ctx.runQuery(internal.mail.ai.catchUpStore.readForMessage, {
			messageId: args.messageId,
			locale: normalizeCatchUpLocale(args.locale),
		});
		const card = state?.aiEnabled && state.cached ? visibleCatchUp(state.cached) : null;
		const coveredAskIds = await checkAskCoverage(ctx, {
			asks: card?.asks ?? [],
			draftText: args.draftText,
			feature: 'answer_ask_coverage',
		});
		return { coveredAskIds };
	},
});
