/**
 * Deployment-wide LLM usage + estimated spend.
 *
 * Every feature that calls an LLM (Postbox AI, the knowledge assistant,
 * translate, knowledge extraction, semantic-file processing, visualization)
 * records one row here, so spend can be reported per feature — complementing the
 * inbound-agent step view in `agentHealth.getCostByStep` (which reads
 * agentActions). `recordLlmSpend` is the helper action callers invoke after each
 * LLM call.
 *
 * The ledger spans all three planes. A row's `plane` tag is optional and absent
 * means `language`, which is what every row written before the decision plane
 * existed is; nothing migrates. DECISION rows carry three more optional flags
 * (`isFallback`, `isCalibrated`, `isThrottled`) so the plane's three counters are
 * derivable from the same rows the enforced ceiling reads, rather than from a
 * second store that can disagree with the bill. See
 * {@link summarizeDecisionPlane}.
 */

import { v } from 'convex/values';
import {
	internalMutation,
	type ActionCtx,
	type MutationCtx,
	type QueryCtx,
} from '../_generated/server';
import { adminQuery } from '../lib/authedFunctions';
import { internal } from '../_generated/api';
import { tokenUsageValidator } from '../lib/convexValidators';
import type { TokenUsage } from '../agent/steps/types';
import { estimateCostUsd, providerLabelForModel } from '../lib/llm/pricing';
import { getBetterAuthSessionWithRole } from '../lib/sessionOrganization';
import { llmUsagePlaneValidator, type LlmUsagePlane } from '../lib/llmUsageTags';

/**
 * Per-row annotations beyond feature and cost, mirroring the table's optional
 * tag columns (`lib/llmUsageTags.ts`). `plane` applies to every plane; the
 * three flags below it are the DECISION plane's and are absent elsewhere. All
 * optional, so a caller that knows none of them writes exactly today's row.
 */
export interface LlmUsageTags {
	readonly plane?: LlmUsagePlane;
	/** The dispatch's id for one logical call, repeated across its retries and its hop. */
	readonly requestId?: string;
	/** The attempt ran on the language-backed fallback hop, not the native plane. */
	readonly isFallback?: boolean;
	/** The answering adapter's probabilities are calibrated across groups. */
	readonly isCalibrated?: boolean;
	/** Upstream pushed back: 429, or 529 (their overload code). */
	readonly isThrottled?: boolean;
}

/**
 * Persist one LLM call's token usage + priced cost. No-ops when usage is absent
 * AND the row is untagged — a call that produced nothing and says nothing about
 * itself is not worth a row. A TAGGED row is written even with no usage, because
 * a throttled or failed decision attempt is precisely what the 429/529 counter
 * is counting, and one that only counts successes hides the outage.
 */
export const record = internalMutation({
	args: {
		feature: v.string(),
		modelUsed: v.optional(v.string()),
		tokenUsage: v.optional(tokenUsageValidator),
		plane: v.optional(llmUsagePlaneValidator),
		requestId: v.optional(v.string()),
		isFallback: v.optional(v.boolean()),
		isCalibrated: v.optional(v.boolean()),
		isThrottled: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		const tags: LlmUsageTags = {
			plane: args.plane,
			requestId: args.requestId,
			isFallback: args.isFallback,
			isCalibrated: args.isCalibrated,
			isThrottled: args.isThrottled,
		};
		const usage = args.tokenUsage;
		if (!usage && args.plane === undefined) return;
		await insertLlmUsage(ctx, args.feature, usage ?? ZERO_USAGE, args.modelUsed, undefined, tags);
	},
});

/** No reported usage: an unknown spend, or a request refused before billing. */
const ZERO_USAGE: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

export interface LlmUsageAttribution {
	readonly organizationId: string;
	readonly pluginId: string;
}

/** Shared mutation-local writer so plugin settlement and its audit stay atomic. */
export async function insertLlmUsage(
	ctx: MutationCtx,
	feature: string,
	tokenUsage: TokenUsage,
	modelUsed: string | undefined,
	attribution?: LlmUsageAttribution,
	tags?: LlmUsageTags
): Promise<void> {
	await ctx.db.insert('llmUsageEvents', {
		feature,
		organizationId: attribution?.organizationId,
		pluginId: attribution?.pluginId,
		modelUsed,
		promptTokens: tokenUsage.promptTokens,
		completionTokens: tokenUsage.completionTokens,
		totalTokens: tokenUsage.totalTokens,
		costUsd: estimateCostUsd(modelUsed, tokenUsage),
		createdAt: Date.now(),
		plane: tags?.plane,
		requestId: tags?.requestId,
		isFallback: tags?.isFallback,
		isCalibrated: tags?.isCalibrated,
		isThrottled: tags?.isThrottled,
	});
}

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

/**
 * The decision plane's writer. Separate from {@link recordLlmSpend} only so no
 * call site has to remember the plane tag or the three flags: the dispatch hands
 * over one attempt record, this turns it into one row, and the row lands BEFORE
 * the answer is used so the enforced ceiling sees the spend it authorised.
 *
 * A failed or throttled attempt is recorded too (using reported usage, if available), because the
 * counters read from these rows are about what the plane DID, not about what it
 * returned.
 */
export async function recordDecisionSpend(
	ctx: ActionCtx,
	feature: string,
	tokenUsage: TokenUsage | undefined,
	modelUsed: string | undefined,
	tags: Omit<LlmUsageTags, 'plane'> = {}
): Promise<void> {
	await ctx.runMutation(internal.analytics.llmUsage.record, {
		feature,
		modelUsed,
		tokenUsage,
		plane: 'decision',
		requestId: tags.requestId,
		isFallback: tags.isFallback,
		isCalibrated: tags.isCalibrated,
		isThrottled: tags.isThrottled,
	});
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
async function recentUsageEvents(ctx: QueryCtx, hoursBack: number, organizationId: string) {
	const since = Date.now() - hoursBack * 60 * 60 * 1000;
	const [legacyCore, tenantAttributed] = await Promise.all([
		ctx.db
			.query('llmUsageEvents')
			.withIndex('by_organization_id_and_created_at', (query) =>
				query.eq('organizationId', undefined).gte('createdAt', since)
			)
			.order('desc')
			.take(5000),
		ctx.db
			.query('llmUsageEvents')
			.withIndex('by_organization_id_and_created_at', (query) =>
				query.eq('organizationId', organizationId).gte('createdAt', since)
			)
			.order('desc')
			.take(5000),
	]);
	return [...legacyCore, ...tenantAttributed]
		.sort((left, right) => right.createdAt - left.createdAt)
		.slice(0, 5000);
}

/** Deployment AI spend grouped by feature over a recent window. */
export const getSpendByFeature = adminQuery({
	args: {
		hoursBack: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const hoursBack = readHoursBack(args.hoursBack);
		const organizationId = await activeLlmOrganizationId(ctx);
		const events = await recentUsageEvents(ctx, hoursBack, organizationId);
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
		const hoursBack = readHoursBack(args.hoursBack);
		const organizationId = await activeLlmOrganizationId(ctx);
		const events = await recentUsageEvents(ctx, hoursBack, organizationId);
		const { groups, totalCostUsd } = groupSpend(events, (e) => providerLabelForModel(e.modelUsed));
		const providers = groups.map(({ key, ...totals }) => ({ provider: key, ...totals }));
		return { providers, totalCostUsd, hoursBack };
	},
});

/** The fields the decision counters read. Structural, so it is testable with plain rows. */
export interface DecisionCountableEvent {
	readonly plane?: LlmUsagePlane;
	readonly isFallback?: boolean;
	readonly isCalibrated?: boolean;
	readonly isThrottled?: boolean;
	readonly costUsd: number;
}

/** The three rates the decision plane is judged by, plus the counts behind them. */
export interface DecisionPlaneCounters {
	/** Rows tagged `decision` in the window — attempts, not answers. */
	attempts: number;
	/** Attempts that ran on the language-backed fallback hop. */
	fallbackAttempts: number;
	/** Attempts answered by an adapter whose probabilities are not calibrated. */
	uncalibratedAttempts: number;
	/** Attempts upstream refused with 429 or 529. */
	throttledAttempts: number;
	/** Attempts that reported a calibration flag at all — the uncalibrated denominator. */
	calibrationReported: number;
	/** `fallbackAttempts / attempts`, 0 when there were none. */
	fallbackRate: number;
	/** `uncalibratedAttempts / calibrationReported`, 0 when nothing reported. */
	uncalibratedRate: number;
	/** `throttledAttempts / attempts`, 0 when there were none. */
	throttledRate: number;
	/** Decision-plane spend in the window. */
	costUsd: number;
}

/**
 * Count the decision plane's three rates off the ledger. Pure, and filtering in
 * memory over a slice the caller already bounded — the `plane` tag is unindexed
 * by design, so this never turns into a fourth index every writer pays for.
 *
 * The denominators differ on purpose. Fallback and throttling are properties of
 * an ATTEMPT (a failed attempt is exactly what they are counting), while
 * calibration is a property of an ANSWER: an attempt that never got one reports
 * no flag and must not be counted as calibrated OR as uncalibrated, which is why
 * it has a denominator of its own.
 */
export function summarizeDecisionPlane(
	events: readonly DecisionCountableEvent[]
): DecisionPlaneCounters {
	const decisions = events.filter((event) => event.plane === 'decision');
	const attempts = decisions.length;
	const fallbackAttempts = decisions.filter((event) => event.isFallback === true).length;
	const calibrationReported = decisions.filter((event) => event.isCalibrated !== undefined).length;
	const uncalibratedAttempts = decisions.filter((event) => event.isCalibrated === false).length;
	const throttledAttempts = decisions.filter((event) => event.isThrottled === true).length;
	const rate = (part: number, whole: number) => (whole > 0 ? part / whole : 0);
	return {
		attempts,
		fallbackAttempts,
		uncalibratedAttempts,
		throttledAttempts,
		calibrationReported,
		fallbackRate: rate(fallbackAttempts, attempts),
		uncalibratedRate: rate(uncalibratedAttempts, calibrationReported),
		throttledRate: rate(throttledAttempts, attempts),
		costUsd: decisions.reduce((sum, event) => sum + event.costUsd, 0),
	};
}

/**
 * Decision-plane health over a recent window: how often the expensive fallback
 * hop fired, how often an answer came back uncalibrated (so every threshold
 * downstream went inert), and how often upstream pushed back. Same bounded slice
 * as the spend queries above.
 */
export const getDecisionPlaneCounters = adminQuery({
	args: {
		hoursBack: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const hoursBack = readHoursBack(args.hoursBack);
		const organizationId = await activeLlmOrganizationId(ctx);
		const events = await recentUsageEvents(ctx, hoursBack, organizationId);
		return { ...summarizeDecisionPlane(events), hoursBack };
	},
});

async function activeLlmOrganizationId(ctx: QueryCtx): Promise<string> {
	const session = await getBetterAuthSessionWithRole(ctx);
	if (!session?.activeOrganizationId || !session.role) {
		throw new Error('LLM usage organization unavailable');
	}
	return session.activeOrganizationId;
}

function readHoursBack(value: number | undefined): number {
	const hours = value ?? 24;
	if (!Number.isFinite(hours) || hours <= 0 || hours > 90 * 24) {
		throw new TypeError('Invalid LLM spend window');
	}
	return hours;
}
