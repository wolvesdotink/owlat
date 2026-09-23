'use node';

/**
 * Today's one-sentence summaries: "Harbor Design sent the final brand assets"
 * rather than a subject line; for a conversation the reader already knew,
 * what changed since they last looked.
 *
 * Advisory and extractive, so it runs on the cheap `summarize` tier behind the
 * same gate as the other user-triggered Postbox AI (the `ai` flag, the spend
 * budget, a per-user rate limit). Mailbox access is enforced by reading the
 * thread through the public, access-checked query. The email text is framed as
 * untrusted data. Any failure simply leaves the plain subject line in place.
 */

import { v } from 'convex/values';
import { authedAction } from '../lib/authedFunctions';
import { api, internal } from '../_generated/api';
import { resolveLanguageModel } from '../lib/llmProvider';
import { runLlmText } from '../lib/llm/dispatch';
import { recordLlmSpend } from '../analytics/llmUsage';
import { SYSTEM_GUARD } from '../mail/ai/promptGuards';
import { threadToText } from '../mail/ai/assist';
import { cleanTodaySentence, todaySummaryPrompt } from './summaryPrompt';

/** At most this many conversations per call (the page asks in small batches). */
const MAX_ITEMS = 8;

// authz: every item is read through mail.mailbox.messages.listThreadMessages,
// which returns null unless the caller can read that mailbox; the gate adds the
// `ai` flag, the spend budget and a per-user rate limit. Writes only the
// derived one-sentence cache for threads the caller could read.
export const summarizeThreads = authedAction({
	args: {
		locale: v.string(),
		items: v.array(v.object({ messageId: v.id('mailMessages'), sinceCount: v.number() })),
	},
	handler: async (ctx, args): Promise<{ written: number }> => {
		await ctx.runMutation(internal.mail.ai.gate.assertAiAllowed, {});
		let written = 0;
		for (const item of args.items.slice(0, MAX_ITEMS)) {
			const thread = await ctx.runQuery(api.mail.mailbox.messages.listThreadMessages, {
				messageId: item.messageId,
			});
			const threadId = thread?.thread?._id;
			if (!thread || !threadId || thread.messages.length === 0) continue;
			const messageCount = thread.messages.length;
			const sinceCount = Math.max(0, Math.min(item.sinceCount, messageCount - 1));
			const { system, prompt } = todaySummaryPrompt({
				guard: SYSTEM_GUARD,
				locale: args.locale,
				isFollowUp: sinceCount > 0,
				earlier: sinceCount > 0 ? await threadToText(thread.messages.slice(0, sinceCount)) : '',
				latest: await threadToText(thread.messages.slice(sinceCount)),
			});
			try {
				const { text, tokenUsage, modelUsed } = await runLlmText({
					model: await resolveLanguageModel(ctx, 'summarize'),
					system,
					prompt,
					temperature: 0.2,
				});
				await recordLlmSpend(ctx, 'today_summarize', tokenUsage, modelUsed);
				const sentence = cleanTodaySentence(text);
				if (!sentence) continue;
				await ctx.runMutation(internal.today.summaryCache.store, {
					threadId,
					locale: args.locale,
					messageCount,
					sinceCount,
					sentence,
				});
				written += 1;
			} catch {
				// Fail soft: the line keeps its subject.
			}
		}
		return { written };
	},
});
