'use node';

/**
 * Answer mode's catch-up card for a team-inbox thread: the twin of
 * mail/ai/catchUp.ts over `inboundMessages`, with the same threshold, prompt,
 * validation and cache (mail/ai/catchUpPrompt.ts, mail/ai/catchUpStore.ts).
 *
 * A team thread holds the customer's messages; the team's sent replies ride on
 * the inbound row they answer. Both go into the transcript, so an ask the team
 * already answered is not listed again, and a citation of a reply points at the
 * message it answered (the one the thread view shows it under).
 *
 * Readers only: the shared-inbox reader gate (inbox/access.ts) through
 * inbox.catchUpStore.readForThread and inbox.queries.getThread. Model calls pass
 * the same AI gate as the Postbox card and the team draft revise.
 */

import { v } from 'convex/values';
import { htmlToPlainText } from '@owlat/shared/html';
import { isCatchUpWorthy } from '@owlat/shared/answerMode';
import { authedAction } from '../lib/authedFunctions';
import { api, internal } from '../_generated/api';
import type { Doc } from '../_generated/dataModel';
import { openInboundMessageBody } from '../lib/messageBodyInbound';
import { stripHiddenContent } from '../agent/steps/security_scan/patterns';
import { gatedInParallel } from '../mail/ai/gate';
import { THREAD_SUMMARY } from '../mail/ai/transcript';
import { checkAskCoverage, generateCatchUp } from '../mail/ai/catchUpGenerate';
import {
	normalizeCatchUpLocale,
	teamCatchUpMessageCount,
	visibleCatchUp,
	type CatchUp,
	type CatchUpEntry,
	type CatchUpMode,
} from '../mail/ai/catchUpPrompt';

/**
 * The body the model may read: the text part, else the HTML as text, with
 * hidden content (comments, display:none, zero-width smuggling) removed first,
 * as the agent's own context step does.
 *
 * Read without storage, as the agent's history is: the transcript keeps a few
 * thousand characters per message, so a part too large for its row contributes
 * its excerpt (the opening of the message) instead of megabytes nobody reads.
 */
async function inboundPlainText(message: Doc<'inboundMessages'>): Promise<string> {
	const { text, html, excerpt } = await openInboundMessageBody(message, null);
	if (text != null && text.trim()) return stripHiddenContent(text).trim();
	if (html != null) return htmlToPlainText(stripHiddenContent(html));
	return stripHiddenContent(excerpt ?? '').trim();
}

/** Inbound messages oldest first, each followed by the reply the team sent to it. */
async function teamCatchUpEntries(messages: Doc<'inboundMessages'>[]): Promise<{
	entries: CatchUpEntry[];
	newestInboundChars: number;
}> {
	const cap = THREAD_SUMMARY.perMessageChars;
	const bodies = await Promise.all(messages.map(inboundPlainText));
	const entries: CatchUpEntry[] = [];
	for (const [index, message] of messages.entries()) {
		entries.push({
			label: `m${index + 1}`,
			messageId: message._id,
			side: 'other',
			text:
				`From: ${message.from} — the other party\nSubject: ${message.subject}\n` +
				(bodies[index] ?? '').slice(0, cap),
		});
		if (message.processingStatus === 'sent' && message.draftResponse) {
			entries.push({
				label: `r${index + 1}`,
				messageId: message._id,
				side: 'owner',
				text: `From: the team — the mailbox owner (you)\n${message.draftResponse.slice(0, cap)}`,
			});
		}
	}
	return { entries, newestInboundChars: (bodies[bodies.length - 1] ?? '').length };
}

// authz: the thread is read through inbox.catchUpStore.readForThread and
// inbox.queries.getThread, both of which return null unless the caller is a
// shared-inbox reader (isSharedInboxReader); org membership is enforced by
// authedAction; the `ai` flag, spend budget and per-user rate limit by
// aiGate.assertAiAllowed before any model call.
export const ensure = authedAction({
	args: { threadId: v.id('conversationThreads'), locale: v.string() },
	handler: async (ctx, args): Promise<CatchUp | null> => {
		const locale = normalizeCatchUpLocale(args.locale);
		const state = await ctx.runQuery(internal.inbox.catchUpStore.readForThread, {
			threadId: args.threadId,
			locale,
		});
		if (!state || !state.aiEnabled) return null;
		if (state.cached) return visibleCatchUp(state.cached);

		const detail = await gatedInParallel(
			ctx,
			ctx.runQuery(api.inbox.queries.getThread, { threadId: args.threadId })
		);
		if (!detail || detail.messages.length === 0) return null;
		const messageCount = teamCatchUpMessageCount(detail.messages);
		const { entries, newestInboundChars } = await teamCatchUpEntries(detail.messages);
		const mode: CatchUpMode = isCatchUpWorthy(messageCount, newestInboundChars)
			? 'full'
			: 'asksOnly';
		const result = await generateCatchUp(ctx, {
			entries,
			mode,
			locale,
			feature: 'answer_catch_up_team',
		});
		if (!result) return null;

		const catchUp: CatchUp = { ...result, messageCount, locale, generatedAt: Date.now() };
		await ctx.runMutation(internal.inbox.catchUpStore.store, {
			conversationThreadId: args.threadId,
			mode,
			catchUp,
		});
		return visibleCatchUp({ mode, ...catchUp });
	},
});

// authz: the card is read through inbox.catchUpStore.readForThread, which
// returns null unless the caller is a shared-inbox reader; org membership is
// enforced by authedAction; the `ai` flag, spend budget and a per-user rate
// limit (its own bucket) by aiGate.assertAiAllowed. The draft text is the
// caller's own.
export const coverage = authedAction({
	args: { threadId: v.id('conversationThreads'), draftText: v.string(), locale: v.string() },
	handler: async (ctx, args): Promise<{ coveredAskIds: string[] }> => {
		const state = await ctx.runQuery(internal.inbox.catchUpStore.readForThread, {
			threadId: args.threadId,
			locale: normalizeCatchUpLocale(args.locale),
		});
		const card = state?.aiEnabled && state.cached ? visibleCatchUp(state.cached) : null;
		const coveredAskIds = await checkAskCoverage(ctx, {
			asks: card?.asks ?? [],
			draftText: args.draftText,
			feature: 'answer_ask_coverage_team',
		});
		return { coveredAskIds };
	},
});
