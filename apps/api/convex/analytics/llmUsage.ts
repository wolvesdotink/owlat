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
import { internalMutation, type ActionCtx, type QueryCtx } from '../_generated/server';
import { adminQuery } from '../lib/authedFunctions';
import { internal } from '../_generated/api';
import { tokenUsageValidator } from '../lib/convexValidators';
import type { TokenUsage } from '../agent/steps/types';
import { estimateCostUsd, providerLabelForModel } from '../lib/llm/pricing';

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
	modelUsed: string | undefined
): Promise<void> {
	if (!tokenUsage) return;
	await ctx.runMutation(internal.analytics.llmUsage.record, { feature, modelUsed, tokenUsage });
}

type SpendTotals = { totalTokens: number; costUsd: number; calls: number };

/**
 * Group priced usage events by a caller-chosen key, summing tokens/cost/calls
 * and returning the groups sorted by cost (desc) plus the window total. The
 * per-feature and per-provider spend queries share this shape and differ only in
 * the grouping key, so both delegate here and rename `key` to their own label.
 */
function groupSpend<E extends { totalTokens: number; costUsd: number }>(
	events: E[],
	keyOf: (event: E) => string
): { groups: Array<SpendTotals & { key: string }>; totalCostUsd: number } {
	const byKey = new Map<string, SpendTotals & { key: string }>();
	for (const event of events) {
		const key = keyOf(event);
		const acc = byKey.get(key) ?? { key, totalTokens: 0, costUsd: 0, calls: 0 };
		acc.totalTokens += event.totalTokens;
		acc.costUsd += event.costUsd;
		acc.calls += 1;
		byKey.set(key, acc);
	}
	const groups = [...byKey.values()].sort((a, b) => b.costUsd - a.costUsd);
	const totalCostUsd = groups.reduce((sum, g) => sum + g.costUsd, 0);
	return { groups, totalCostUsd };
}

/** The most-recent LLM usage events within a window, capped for a bounded scan. */
async function recentUsageEvents(ctx: QueryCtx, hoursBack: number) {
	const since = Date.now() - hoursBack * 60 * 60 * 1000;
	return await ctx.db
		.query('llmUsageEvents')
		.withIndex('by_creation_time', (q) => q.gte('_creationTime', since))
		.order('desc')
		.take(5000);
}

/** Deployment AI spend grouped by feature over a recent window. */
export const getSpendByFeature = adminQuery({
	args: {
		hoursBack: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const hoursBack = args.hoursBack ?? 24;
		const events = await recentUsageEvents(ctx, hoursBack);
		const { groups, totalCostUsd } = groupSpend(events, (e) => e.feature);
		const features = groups.map(({ key, ...totals }) => ({ feature: key, ...totals }));
		return { features, totalCostUsd, hoursBack };
	},
});

/**
 * Deployment AI spend grouped by PROVIDER BACKEND over a recent window, so an
 * admin who switches or splits providers reads spend per backend (OpenAI vs
 * Anthropic vs a local model vs OpenRouter) — complementing the per-feature
 * view above. The provider is derived from each row's recorded model id
 * ({@link providerLabelForModel}); no schema column is needed, so this works for
 * every historical row too.
 */
export const getSpendByProvider = adminQuery({
	args: {
		hoursBack: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const hoursBack = args.hoursBack ?? 24;
		const events = await recentUsageEvents(ctx, hoursBack);
		const { groups, totalCostUsd } = groupSpend(events, (e) => providerLabelForModel(e.modelUsed));
		const providers = groups.map(({ key, ...totals }) => ({ provider: key, ...totals }));
		return { providers, totalCostUsd, hoursBack };
	},
});
