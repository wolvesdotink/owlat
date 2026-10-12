/**
 * The optional tags on an `llmUsageEvents` row, defined once and imported by
 * BOTH the table (`schema/inbox.ts`) and the writer (`analytics/llmUsage.ts`),
 * the way `tokenUsageValidator` is — a row shape and the code that fills it
 * should not be able to drift apart.
 *
 * All six are optional and none is indexed, which is the whole design:
 *
 *   • every row written before the decision plane existed is language-plane
 *     spend, so an absent `plane` READS AS `language` and nothing migrates;
 *   • the reads that care take the same bounded recent slice the spend
 *     dashboard already takes and filter in memory, rather than making every
 *     writer on a high-churn ledger pay for a fourth index serving one admin
 *     query.
 *
 * The three flags below `plane` are the DECISION plane's and are absent
 * everywhere else. They exist so that plane's three counters — how often the
 * expensive fallback hop fired, how often an answer came back uncalibrated, how
 * often upstream pushed back — are derivable from the SAME rows the enforced
 * dollar ceiling reads, rather than from a second store that can disagree with
 * the bill.
 */

import { v } from 'convex/values';
import { literalUnion } from './literalUnion';
import {
	aiTaskNameValidator,
	budgetClassValidator,
	qualityResultValidator,
} from './validators/aiRouting';

/**
 * The planes a row's spend can belong to, as a runtime tuple so the type and
 * the validator below cannot drift: a fourth plane added to one of them alone
 * would typecheck everywhere and then fail at runtime, on the insert, with an
 * ArgumentValidationError. Same shape as the provider-kind unions two files
 * over.
 */
export const LLM_USAGE_PLANES = ['language', 'embedding', 'decision'] as const;

/** The plane a row's spend belongs to. Absent on a row ⇒ `language`. */
export type LlmUsagePlane = (typeof LLM_USAGE_PLANES)[number];

export const llmUsagePlaneValidator = literalUnion(LLM_USAGE_PLANES);

/**
 * The AI routing columns (ADR-0073, Phase 1a and 1b). All optional: a row
 * written before them, or by a caller that knows none of them, is exactly
 * today's row. One row is still one provider request, and the ledger is still
 * the single source of settled spend; these columns say which logical request
 * the row belongs to and what it cost in detail.
 *
 * Only `reservationId` is indexed (settling a crashed reservation needs the rows
 * it already wrote); reports read a bounded slice and group in memory, as the
 * comment above explains for the tags.
 */
export const llmUsageRoutingFields = {
	/** The outermost request this call serves (one inbound message's run, one user action). */
	rootRequestId: v.optional(v.string()),
	/** The call that issued this one (a nested assistant tool, a quality escalation). */
	parentCallId: v.optional(v.string()),
	/** The task-policy catalog name (`lib/llm/taskPolicy.ts`). */
	task: v.optional(aiTaskNameValidator),
	/** `aiRoutingPolicy.policyVersion` the call was routed under. */
	policyVersion: v.optional(v.number()),
	/** 1-based provider request number within the logical call (`requestId`). */
	attempt: v.optional(v.number()),
	/**
	 * Secret-free identity of the endpoint that answered: a language
	 * `LanguageEndpointProvenance`, a decision `DecisionEndpointProvenance`, or
	 * `embedding:<provider kind>`. Never a URL with credentials, never a key.
	 */
	endpoint: v.optional(v.string()),
	/** Billed usage the three token totals above do not break out. */
	cacheReadTokens: v.optional(v.number()),
	cacheWriteTokens: v.optional(v.number()),
	reasoningTokens: v.optional(v.number()),
	/** Wall time of this provider request, in ms. */
	latencyMs: v.optional(v.number()),
	/** The quality assessment of what this call produced (Phase 4). Absent ⇒ not assessed. */
	qualityResult: v.optional(qualityResultValidator),
	/** The pricing catalog revision `costUsd` was computed with. Rows are never repriced. */
	priceVersion: v.optional(v.string()),
	/** `costUsd` is a conservative estimate (usage missing, cancelled, crashed), not reported usage. */
	isEstimated: v.optional(v.boolean()),
	/** `costUsd` in integer micro-USD, rounded up: what the period aggregate adds. */
	costMicrousd: v.optional(v.number()),
	/** The ceiling slice the call drew on. Absent ⇒ `standard`. */
	budgetClass: v.optional(budgetClassValidator),
	/** The admission reservation the call ran under (`llmReservations.reservationId`). */
	reservationId: v.optional(v.string()),
};

/** Spread into `defineTable` beside the priced columns. */
export const llmUsageTagFields = {
	plane: v.optional(llmUsagePlaneValidator),
	/**
	 * The dispatch's stable id for ONE logical call, repeated on every attempt of
	 * it and on the fallback hop. Written so three rows of one retried decision
	 * are identifiable as one decision rather than reading as three; nothing
	 * de-duplicates on it yet, and the vendor documents no idempotency key of its
	 * own, so this is an accounting handle and not a promise of a free retry.
	 */
	requestId: v.optional(v.string()),
	/** The attempt ran on the language-backed fallback hop, not the native plane. */
	isFallback: v.optional(v.boolean()),
	/** The answering adapter's probabilities are calibrated across groups. */
	isCalibrated: v.optional(v.boolean()),
	/** Upstream pushed back: 429, or 529 (their overload code). */
	isThrottled: v.optional(v.boolean()),
	/**
	 * The attempt ran on an engine on the operator's own hardware (the local
	 * decision adapter). Such a row costs nothing and files under `Local`,
	 * whatever checkpoint answered: the model id cannot say where a model ran,
	 * and an operator's own fine-tune has an id no price table will ever know.
	 */
	isLocalEngine: v.optional(v.boolean()),
	...llmUsageRoutingFields,
};

/**
 * An `LlmRootContext` (`lib/llm/requestMeter.ts`) passed as an argument into an
 * action that makes model calls on the caller's behalf (a retrieval search, a
 * nested assistant tool), so its rows group under the caller's root request.
 */
export const llmRootContextValidator = v.object({
	rootRequestId: v.string(),
	parentCallId: v.optional(v.string()),
	deadlineAt: v.optional(v.number()),
});
