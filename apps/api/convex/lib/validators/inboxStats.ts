import { v } from 'convex/values';

/**
 * The inbox processing-status counters (`lib/inboxStats.ts`). Stored on the
 * `inbox` row of `instanceCounters`; the copy on `instanceSettings` is the
 * deprecated pre-split location, read only as a fallback.
 */
export const inboxStatsValidator = v.object({
	received: v.number(),
	processing: v.number(), // security_check + classifying + drafting
	draftReady: v.number(),
	approved: v.number(),
	sent: v.number(),
	quarantined: v.number(),
	failed: v.number(),
	rejected: v.number(),
	archived: v.number(),
	// Parked as needs-no-reply (the Updates dashboard). Optional: rows
	// written before the bucket existed have no field and read as 0.
	informational: v.optional(v.number()),
	total: v.number(),
});
