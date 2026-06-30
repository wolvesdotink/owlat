/**
 * Deployment-wide LLM usage + estimated spend.
 *
 * Every feature that calls an LLM (Postbox AI, the knowledge assistant,
 * translate, knowledge extraction, semantic-file processing, visualization)
 * records one row here, so spend can be reported per feature — complementing the
 * inbound-agent step view in `agentHealth.getCostByStep` (which reads
 * agentActions). `recordLlmSpend` is the helper action callers invoke after each
 * LLM call.
 */

import { v } from 'convex/values';
import { internalMutation, type ActionCtx } from '../_generated/server';
import { adminQuery } from '../lib/authedFunctions';
import { internal } from '../_generated/api';
import { tokenUsageValidator } from '../lib/convexValidators';
import type { TokenUsage } from '../agent/steps/types';
import { estimateCostUsd } from '../lib/llm/pricing';

/** Persist one LLM call's token usage + priced cost. No-ops when usage is absent. */
export const record = internalMutation({
	args: {
		feature: v.string(),
		modelUsed: v.optional(v.string()),
		tokenUsage: v.optional(tokenUsageValidator),
	},
	handler: async (ctx, args) => {
		const usage = args.tokenUsage;
		if (!usage) return;
		await ctx.db.insert('llmUsageEvents', {
			feature: args.feature,
			modelUsed: args.modelUsed,
			promptTokens: usage.promptTokens,
			completionTokens: usage.completionTokens,
			totalTokens: usage.totalTokens,
			costUsd: estimateCostUsd(args.modelUsed, usage),
			createdAt: Date.now(),
		});
	},
});

/**
 * Helper for action callers: record one LLM call's spend under a feature tag.
 * Best-effort — never throws on the caller's critical path is the caller's job
 * (this awaits a cheap internal mutation).
 */
export async function recordLlmSpend(
	ctx: ActionCtx,
	feature: string,
	tokenUsage: TokenUsage | undefined,
	modelUsed: string | undefined,
): Promise<void> {
	if (!tokenUsage) return;
	await ctx.runMutation(internal.analytics.llmUsage.record, { feature, modelUsed, tokenUsage });
}

/** Deployment AI spend grouped by feature over a recent window. */
export const getSpendByFeature = adminQuery({
	args: {
		hoursBack: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const since = Date.now() - (args.hoursBack ?? 24) * 60 * 60 * 1000;
		// bounded: windowed scan capped at the most-recent 5000 usage events.
		const events = await ctx.db
			.query('llmUsageEvents')
			.withIndex('by_creation_time', (q) => q.gte('_creationTime', since))
			.order('desc')
			.take(5000);

		const byFeature = new Map<string, { feature: string; totalTokens: number; costUsd: number; calls: number }>();
		for (const e of events) {
			const acc = byFeature.get(e.feature) ?? { feature: e.feature, totalTokens: 0, costUsd: 0, calls: 0 };
			acc.totalTokens += e.totalTokens;
			acc.costUsd += e.costUsd;
			acc.calls += 1;
			byFeature.set(e.feature, acc);
		}
		const features = [...byFeature.values()].sort((a, b) => b.costUsd - a.costUsd);
		const totalCostUsd = features.reduce((sum, f) => sum + f.costUsd, 0);
		return { features, totalCostUsd, hoursBack: args.hoursBack ?? 24 };
	},
});
