/**
 * The optional tags on an `llmUsageEvents` row, defined once and imported by
 * BOTH the table (`schema/inbox.ts`) and the writer (`analytics/llmUsage.ts`),
 * the way `tokenUsageValidator` is — a row shape and the code that fills it
 * should not be able to drift apart.
 *
 * All five are optional and none is indexed, which is the whole design:
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
import { literalUnion } from './convexValidators';

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
};
