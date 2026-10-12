/**
 * Deployment-wide LLM usage + estimated spend.
 *
 * Every feature that calls a model (Postbox AI, the knowledge assistant,
 * translate, knowledge extraction, semantic-file processing, visualization,
 * embeddings, the decision plane, and each step of the Team Inbox agent under
 * an `agent_*` feature) records here, so spend can be reported per feature.
 * This ledger is the one store the enforced spend ceiling reads
 * (`analytics/spendBudget.ts`). The inbound-agent step view in
 * `agentHealth.getCostByStep` reads the usage the walker also keeps on
 * `agentActions`; that is a per-step reporting view of calls already counted
 * here, not a second money store (#1259).
 *
 * ONE ROW PER PROVIDER REQUEST (ADR-0073). A retried call, a tool loop and a
 * stream write one row per request they made, each with its `attempt` number
 * under the call's `requestId`. The dispatch records the requests on an
 * `LlmCallMeter`; `analytics/meteredSpend.ts` and the decision plane's
 * recorder (`lib/decision/ports.ts`) write them through {@link recordRequests}.
 * {@link insertLlmUsage} is the only code that inserts a row, and it adds the
 * row to the spend-period aggregate in the same mutation
 * (`lib/aiRouting/spendPeriodWrites.ts`), so every row is counted once.
 *
 * The ledger spans all three planes. A row's `plane` tag is optional and absent
 * means `language`, which is what every row written before the decision plane
 * existed is; nothing migrates. DECISION rows carry three more optional flags
 * (`isFallback`, `isCalibrated`, `isThrottled`) so the plane's three counters are
 * derivable from the same rows the enforced ceiling reads, rather than from a
 * second store that can disagree with the bill. See
 * {@link summarizeDecisionPlane}.
 */

import { v, type Infer } from 'convex/values';
import type { QueryCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { adminQuery } from '../lib/authedFunctions';
import { tokenUsageValidator } from '../lib/convexValidators';
import { providerLabelForModel } from '../lib/llm/pricing';
import { getBetterAuthSessionWithRole } from '../lib/sessionOrganization';
import {
	llmUsagePlaneValidator,
	llmUsageRoutingFields,
	type LlmUsagePlane,
} from '../lib/llmUsageTags';
import { insertLlmUsage, ZERO_USAGE } from './ledgerInsert';
import { SETTLEMENT_FEATURE, settleReservation } from '../aiRouting/settlement';

export { insertLlmUsage, type LlmUsageTags } from './ledgerInsert';

/** The writer-supplied routing columns: everything but the three it computes. */
const {
	priceVersion: _priceVersion,
	costMicrousd: _costMicrousd,
	...routingArgs
} = llmUsageRoutingFields;

/** The tag arguments every ledger mutation accepts. */
const tagArgs = {
	plane: v.optional(llmUsagePlaneValidator),
	requestId: v.optional(v.string()),
	isFallback: v.optional(v.boolean()),
	isCalibrated: v.optional(v.boolean()),
	isThrottled: v.optional(v.boolean()),
	isLocalEngine: v.optional(v.boolean()),
	...routingArgs,
};

/**
 * COMPATIBILITY: the previous release's single-row writer, kept with its exact
 * arguments so spend writes already scheduled against it, and actions still
 * running the previous release, land in the ledger after the deploy instead of
 * failing. New code writes through {@link recordRequests}. Behaves as before:
 * no usage and no plane writes nothing; a tagged row without usage is a
 * zero-cost estimate. Remove once a release has shipped without callers
 * (`scripts/check-entry-wiring.ts` PREVIOUS_RELEASE_ENTRIES).
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
		isLocalEngine: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		const { feature, modelUsed, tokenUsage, ...tags } = args;
		if (!tokenUsage && args.plane === undefined) return;
		await insertLlmUsage(ctx, feature, tokenUsage ?? ZERO_USAGE, modelUsed, undefined, {
			...tags,
			...(tokenUsage ? {} : { isEstimated: true }),
		});
	},
});

/** One provider request of a metered call (`lib/llm/requestMeter.ts` `LlmRequestRecord`). */
export const meteredRequestValidator = v.object({
	attempt: v.number(),
	usage: v.optional(tokenUsageValidator),
	cacheReadTokens: v.optional(v.number()),
	cacheWriteTokens: v.optional(v.number()),
	reasoningTokens: v.optional(v.number()),
	latencyMs: v.number(),
	modelUsed: v.optional(v.string()),
	endpoint: v.optional(v.string()),
	isThrottled: v.optional(v.boolean()),
	isLocalEngine: v.optional(v.boolean()),
	isFallback: v.optional(v.boolean()),
	isCalibrated: v.optional(v.boolean()),
	/** The admission hold the request ran under, when it differs per request (one meter, several dispatches). */
	reservationId: v.optional(v.string()),
});

export type MeteredRequest = Infer<typeof meteredRequestValidator>;

/** Requests per write: a tool loop's steps times its attempts, with room to spare. */
export const MAX_METERED_REQUESTS_PER_WRITE = 64;

/**
 * Write one row per provider request of one logical call, in one mutation. The
 * call-level tags apply to every row; each request brings its own attempt,
 * usage, latency and model. A request with no reported usage writes a zero-cost
 * row marked `isEstimated`: it was made, and a ledger that hides it under-counts
 * attempts.
 *
 * IDEMPOTENT by `(requestId, attempt)`: a request whose row already exists is
 * skipped, so a writer that retries a batch after an ambiguous failure (the
 * mutation committed, the reply was lost) writes nothing twice.
 */
/** The arguments of {@link recordRequests}: one call's tags and its requests. */
const recordRequestsArgs = {
	feature: v.string(),
	...tagArgs,
	requests: v.array(meteredRequestValidator),
	/**
	 * Admission holds whose dispatch is over, settled in this mutation once its
	 * rows are in (`aiRouting/settlement.ts`). `expectedRequests` is every
	 * request the hold covered; a hold whose rows are not all in the ledger yet
	 * stays held, and the expiry sweep settles it.
	 */
	settlements: v.optional(
		v.array(v.object({ reservationId: v.string(), expectedRequests: v.number() }))
	),
};

/** One batch as {@link recordRequests} takes it (typed off the validator, not the api). */
export type RequestBatchArgs = Infer<ReturnType<typeof v.object<typeof recordRequestsArgs>>>;

export const recordRequests = internalMutation({
	args: recordRequestsArgs,
	handler: async (ctx, args) => {
		const { feature, requests, settlements, ...tags } = args;
		if (requests.length > MAX_METERED_REQUESTS_PER_WRITE) {
			throw new Error('Too many metered requests in one write');
		}
		for (const request of requests) {
			if (tags.requestId !== undefined) {
				const existing = await ctx.db
					.query('llmUsageEvents')
					.withIndex('by_request_id_and_attempt', (q) =>
						q.eq('requestId', tags.requestId).eq('attempt', request.attempt)
					)
					.first();
				if (existing) continue;
			}
			const { usage, modelUsed, ...requestTags } = request;
			await insertLlmUsage(ctx, feature, usage ?? ZERO_USAGE, modelUsed, undefined, {
				...tags,
				...requestTags,
				isEstimated: usage === undefined,
			});
		}
		for (const settlement of settlements ?? []) {
			await settleReservation(ctx, settlement.reservationId, {
				mode: 'call_end',
				expectedRequests: settlement.expectedRequests,
			});
		}
	},
});

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
 * ({@link providerLabelForModel}), so it works for every historical row too —
 * except for a row the local engine answered, which says so itself
 * (`isLocalEngine`) because its model id may be anything at all.
 */
export const getSpendByProvider = adminQuery({
	args: {
		hoursBack: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const hoursBack = readHoursBack(args.hoursBack);
		const organizationId = await activeLlmOrganizationId(ctx);
		const events = await recentUsageEvents(ctx, hoursBack, organizationId);
		const { groups, totalCostUsd } = groupSpend(events, (e) =>
			e.isLocalEngine === true ? 'Local' : providerLabelForModel(e.modelUsed)
		);
		const providers = groups.map(({ key, ...totals }) => ({ provider: key, ...totals }));
		return { providers, totalCostUsd, hoursBack };
	},
});

/** The fields the decision counters read. Structural, so it is testable with plain rows. */
export interface DecisionCountableEvent {
	readonly plane?: LlmUsagePlane;
	/** Absent in older callers; a settlement estimate row is not counted as an attempt. */
	readonly feature?: string;
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
	// A settlement estimate (admission) is spend, not an attempt.
	const requests = decisions.filter((event) => event.feature !== SETTLEMENT_FEATURE);
	const attempts = requests.length;
	const fallbackAttempts = requests.filter((event) => event.isFallback === true).length;
	const calibrationReported = requests.filter((event) => event.isCalibrated !== undefined).length;
	const uncalibratedAttempts = requests.filter((event) => event.isCalibrated === false).length;
	const throttledAttempts = requests.filter((event) => event.isThrottled === true).length;
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
