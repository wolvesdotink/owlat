import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * WHAT RECEIVERS SAID, PER CELL AND PER ARM — the transport-telemetry surface
 * the ramp's gate-2 block clause reads (issue #501).
 *
 * The MTA classifies every 4xx/5xx it gets into
 * `@owlat/shared/smtpBlockCategories`' vocabulary, and until this table existed
 * that verdict never left the MTA: the block clause had a reader and no
 * producer, so `evaluateSmtpBlockMessages` returned null on every tick of every
 * deployment. The categories now travel as a typed field on an
 * `smtp.classified` webhook and land here, keyed the way the outcomes they sit
 * beside are.
 *
 * SHAPE IS COPIED FROM `transportOutcomes` DELIBERATELY (plan D5, ADR-0042), and
 * it is the same shape for the same three reasons:
 *   - Each (org, cell, arm, day) bucket is SHARDED into `shardKey` 0..N-1 rows.
 *     One classified response bumps ONE random shard, so a blast's deferrals
 *     spread across N documents instead of read-modify-writing a single daily
 *     row once per recipient (the Convex OCC write hotspot ADR-0042 was written
 *     about).
 *   - `analytics/smtpResponseCategories.ts` holds the ONE reader-typed
 *     summarizer, which sums across shards so the split is invisible to readers.
 *   - NO RATE IS STORED. The block RATE is derived on read — and not even here:
 *     the summarizer produces COUNTS (`SmtpBlockObservation`) and the gate
 *     divides, once, in `delivery/ramp/trailingBaselineGates.ts`. A rate in this
 *     table would be a second answer the controller and the dashboard could
 *     disagree about.
 *
 * DAY-BUCKETED, because two windows read it: the controller's 24-hour
 * evaluation window and the dashboard's seven days. Both are whole numbers of
 * UTC days over the same rows, which is what lets one read serve both.
 *
 * WHY ITS OWN TABLE RATHER THAN COLUMNS ON `transportOutcomes`. That table's
 * columns are a CLOSED vocabulary of nine lifecycle events; this one's is an
 * open-ended set of classifier categories that grows whenever a receiver invents
 * a new refusal, and fourteen more integer columns — most of them zero on every
 * row — would be a schema migration every time the MTA learns a phrase. The two
 * are also written from different places at different rates: a lifecycle
 * transition per recipient there, a receiver response per ATTEMPT here.
 *
 * `organizationId` leads every caller-reachable index, for the same reason it
 * does on `transportOutcomes` and `sendAssignments`: a cell-keyed table readable
 * across tenants is a security defect.
 *
 * Spread into `defineSchema()` from schema.ts via `...smtpResponseCategoryTables`.
 */
export const smtpResponseCategoryTables = {
	smtpResponseCategories: defineTable({
		organizationId: v.string(),
		// `${stream}:${destinationProvider}` — see @owlat/shared/deliverabilityRouting.
		cell: v.string(),
		// Which arm carried the message the receiver answered. Learned by joining
		// the send through its `sendAssignments` row — never guessed from the wire,
		// which carries no arm at all.
		arm: v.union(v.literal('own'), v.literal('reference')),
		periodStart: v.number(), // UTC start-of-day bucket (epoch ms)
		shardKey: v.number(), // 0..N-1 write shard within the (org, cell, arm, day) bucket

		/**
		 * Every classified response that landed on this shard — the DENOMINATOR of
		 * the block rate, and the sample the gate's floor is measured against.
		 *
		 * Kept as its own column rather than derived by summing `byCategory`: the
		 * two are written together in one patch and can never disagree, and a reader
		 * that had to sum an open-ended map to learn the sample size would be
		 * deriving the denominator from a set of keys it has just narrowed — so a
		 * category the vocabulary no longer recognises would silently shrink the
		 * denominator and inflate the rate.
		 */
		observed: v.number(),
		/**
		 * AGGREGATED — per-category counts, keyed by `SmtpFailureCategory`.
		 *
		 * `v.record(v.string(), v.number())` and not a fixed object, because the
		 * classifier's vocabulary is the MTA's to grow: a receiver phrase that earns
		 * a new category must not need a schema migration before it can be counted.
		 * The keys are narrowed ONCE, on read, by `isSmtpFailureCategory` — the
		 * WHOLE vocabulary and not the block subset, which would drop every
		 * rate-pressure category the audit row exists to carry.
		 */
		byCategory: v.record(v.string(), v.number()),

		/**
		 * Freshness of this shard, surfaced by the summarizer as the window's newest
		 * `observedAt`. Gate 2's block clause refuses to halt on stale evidence and
		 * reads that instant through the same seam as the counts.
		 */
		lastRecordedAt: v.number(),
	})
		// Org-leading, then the cell/arm/day/shard prefix the reader walks.
		.index('by_org_cell_arm_period_shard', [
			'organizationId',
			'cell',
			'arm',
			'periodStart',
			'shardKey',
		])
		// The aging sweep is deployment-wide (it must not need to enumerate orgs to
		// find old buckets), so it reads the bucket day directly.
		.index('by_period_start', ['periodStart']),
};
