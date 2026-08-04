import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * Google Postmaster Tools v2 telemetry.
 *
 * The signed MTA collector is the only writer for both tables and raw OAuth
 * credentials never enter Convex. Postmaster is an ADDITIVE-ONLY signal: an
 * operator who never connects a Google account simply has no rows here, which
 * lowers measurement confidence and nothing else — it is never an error state
 * and never blocks a send.
 */
export const postmasterTables = {
	// One idempotent row per verified authentication domain per UTC day. Every
	// field beyond the spam ratio is optional: Google withholds a metric on days
	// a domain had too little traffic, and rows written before the v2 metric
	// widening carry the spam ratio alone. The retention sweep keeps 90 days.
	googlePostmasterStats: defineTable({
		domainId: v.id('domains'),
		domain: v.string(),
		periodStart: v.number(),
		userReportedSpamRatio: v.number(),
		/** Share of traffic passing SPF / DKIM / DMARC, as Google measured it. */
		spfSuccessRatio: v.optional(v.number()),
		dkimSuccessRatio: v.optional(v.number()),
		dmarcSuccessRatio: v.optional(v.number()),
		/** Aggregate delivery-error rate, with its per-category breakdown. */
		deliveryErrorRatio: v.optional(v.number()),
		deliveryErrors: v.optional(v.array(v.object({ category: v.string(), ratio: v.number() }))),
		fetchedAt: v.number(),
		ingestedAt: v.number(),
	})
		.index('by_domain_period', ['domain', 'periodStart'])
		.index('by_domain_id', ['domainId'])
		.index('by_period', ['periodStart']),

	// The v2 Compliance Status verdict: one row per domain per UTC day holding
	// each check's pass/fail. `state: 'unknown'` is a first-class outcome — a
	// check Google reports in a spelling we do not recognise is retained rather
	// than dropped, so a future reader can still see it was evaluated.
	googlePostmasterCompliance: defineTable({
		domainId: v.id('domains'),
		domain: v.string(),
		periodStart: v.number(),
		checks: v.array(
			v.object({
				name: v.string(),
				state: v.union(v.literal('passing'), v.literal('failing'), v.literal('unknown')),
			})
		),
		fetchedAt: v.number(),
		ingestedAt: v.number(),
	})
		.index('by_domain_period', ['domain', 'periodStart'])
		.index('by_domain_id', ['domainId'])
		.index('by_period', ['periodStart']),
};
