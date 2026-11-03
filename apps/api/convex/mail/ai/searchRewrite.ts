'use node';

/**
 * "Search for: …" — turn a plain-language Postbox search into the operator
 * query it describes, for the search page to offer as an editable suggestion.
 *
 * Reads no mail. The only input is the caller's own search text, and the output
 * is a query string the person runs themselves through the ordinary search,
 * which enforces mailbox access and the body-search setting. The prompt and the
 * normalizer are pure and live in `./searchRewriteText`.
 */

import { v } from 'convex/values';
import { authedAction } from '../../lib/authedFunctions';
import { resolveLanguageModel } from '../../lib/llmProvider';
import { runLlmText } from '../../lib/llm/dispatch';
import { interactiveLlmPolicy } from '../../lib/llm/retryPolicy';
import { meterLlmCall } from '../../analytics/meteredSpend';
import { newRootRequest } from '../../lib/llm/requestMeter';
import { anchorActionDeadline } from '../../lib/llm/actionDeadline';
import { gatedInParallel } from './gate';
import {
	MAX_SEARCH_REWRITE_INPUT_CHARS,
	buildSearchRewritePrompt,
	isSearchRewriteCandidate,
	normalizeSearchRewrite,
	resolveRewriteToday,
} from './searchRewriteText';

/**
 * Suggest an operator query for a plain-language search. `query: null` means
 * there is nothing to offer: the search already uses operators (no model call,
 * no spend), the model found no operator that fits, or its answer was cut off.
 * `today` is the browser's local date (YYYY-MM-DD), so "last week" means the
 * person's week.
 */
// authz: org membership enforced by authedAction; the `ai` flag, spend admission
// and the per-user rate limit enforced by gate.assertAiAllowed. Reads no
// workspace data: the only input is the caller's own search text.
export const rewriteSearch = authedAction({
	args: {
		query: v.string(),
		today: v.optional(v.string()),
	},
	handler: async (ctx, args): Promise<{ query: string | null }> => {
		// One model budget for this action, from its start.
		anchorActionDeadline(ctx);
		const original = args.query.trim().slice(0, MAX_SEARCH_REWRITE_INPUT_CHARS);
		if (!isSearchRewriteCandidate(original)) return { query: null };
		const model = await gatedInParallel(ctx, resolveLanguageModel(ctx, 'mail.search_rewrite'));
		const { system, prompt } = buildSearchRewritePrompt({
			query: original,
			today: resolveRewriteToday(args.today, Date.now()),
		});
		const { text, isTruncated } = await meterLlmCall(
			ctx,
			{ feature: 'postbox_search_rewrite', root: newRootRequest('postbox_action') },
			(meter) =>
				runLlmText({
					meter,
					model,
					system,
					prompt,
					temperature: 0,
					...interactiveLlmPolicy('reply'),
				}),
			{ write: 'schedule', rethrow: 'as_is' }
		);
		// A cut-off line may have lost the operator that mattered.
		if (isTruncated === true) return { query: null };
		return { query: normalizeSearchRewrite(text, original) };
	},
});
