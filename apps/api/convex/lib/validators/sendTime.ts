import { v, type Infer } from 'convex/values';

/**
 * Validators for send-time optimization (ADR-0068): the per-contact
 * engagement profile cached on the contact row, the organization histogram
 * shards, a campaign's optimization settings and the group an `emailSends` row
 * was planned in. The arithmetic lives in `analytics/sendTimeProfile.ts`; the
 * planner in `campaigns/sendTimeOptimization.ts`.
 */

/**
 * A time-decayed engagement histogram. `hours` has 24 entries (local hour of
 * day), `days` has 7 (local weekday, 0 = Sunday). Every entry, and `total`,
 * is "as of" `asOf`: decaying the whole histogram to a later instant scales
 * them all by the same factor.
 */
export const sendTimeHistogramFields = {
	hours: v.array(v.number()),
	days: v.array(v.number()),
	total: v.number(),
	asOf: v.number(),
};

/**
 * A contact's profile: the histogram plus the IANA zone its local hours were
 * read in, fixed when the first engagement was folded.
 */
export const sendTimeProfileValidator = v.object({
	...sendTimeHistogramFields,
	timeZone: v.string(),
});

/** A campaign's "Optimized per contact" settings. Absent = not optimized. */
export const sendTimeOptimizationValidator = v.object({
	/** Hours after the start in which each contact's send may be placed. */
	windowHours: v.number(),
	/** Share of the audience (0-50) sent at the start time as a comparison group. */
	holdoutPercent: v.number(),
});
export type SendTimeOptimizationSettings = Infer<typeof sendTimeOptimizationValidator>;

/** Which arm of an optimized campaign a send belongs to. */
export const sendTimeGroupValidator = v.union(v.literal('optimized'), v.literal('holdout'));
export type SendTimeGroup = Infer<typeof sendTimeGroupValidator>;
