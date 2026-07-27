import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * Per-cell, per-arm rolling OUTCOME counters — the table that measures
 * DELIVERABILITY rather than ACCEPTANCE (plan G-05: a message Gmail accepts and
 * files into Spam currently counts as a 100% success, because the only thing
 * recorded is that the transport took it).
 *
 * Its own schema sibling rather than another entry in `schema/delivery.ts`: that
 * file sits at the file-size cap, and CONVENTIONS.md → "Add new tables"
 * sanctions a feature-named sibling in exactly that case (the
 * `schema/sendAssignments.ts` precedent).
 *
 * SHAPE IS COPIED FROM `sendingReputation` DELIBERATELY (plan D5, ADR-0042):
 *   - Each (org, cell, arm, day) bucket is SHARDED into `shardKey` 0..N-1 rows.
 *     One lifecycle event bumps ONE random shard, so a blast's per-recipient
 *     writes spread across N documents instead of read-modify-writing a single
 *     daily row N times (the Convex OCC write hotspot ADR-0042 was written
 *     about).
 *   - `analytics/transportOutcomes.ts` holds the ONE reader-typed summarizer,
 *     which sums across all shards so the split is invisible to readers.
 *   - NO RATE IS STORED. Bounce / complaint / delivery / open / click rates are
 *     derived on read, in that one summarizer, so the ramp controller and the
 *     dashboard cannot disagree about a number.
 *
 * `organizationId` is not in the plan's sketch and is deliberately added, for
 * the same reason as `sendAssignments`: a cell-keyed table readable across
 * tenants is a security defect, so the bucket index is org-leading and no query
 * can cross tenants.
 *
 * Spread into `defineSchema()` from schema.ts via `...transportOutcomeTables`.
 */
export const transportOutcomeTables = {
	transportOutcomes: defineTable({
		organizationId: v.string(),
		// `${stream}:${destinationProvider}` — see @owlat/shared/deliverabilityRouting.
		cell: v.string(),
		// Which arm of the cell produced the outcome. Learned by joining the
		// send through its `sendAssignments` row — never guessed from the Send.
		arm: v.union(v.literal('own'), v.literal('reference')),
		periodStart: v.number(), // UTC start-of-day bucket (epoch ms)
		shardKey: v.number(), // 0..N-1 write shard within the (org, cell, arm, day) bucket

		// ── Counters. Monotonic within a bucket; every RATE is derived on read. ──
		sent: v.number(),
		delivered: v.number(),
		deferred: v.number(),
		softBounced: v.number(),
		hardBounced: v.number(),
		complained: v.number(),
		opened: v.number(),
		clicked: v.number(),
		unsubscribed: v.number(),

		// The randomized calibration slice (plan D8) is counted SEPARATELY, not
		// as a subset a reader has to remember to exclude: the engagement-ratio
		// gate reads ONLY the calibration slice, because stratified assignment
		// destroys the causal comparison. A summarizer that folded these into the
		// general counters would silently feed the gate a stratified number.
		calibrationSent: v.number(),
		calibrationOpened: v.number(),
		calibrationClicked: v.number(),

		lastRecordedAt: v.number(),
	})
		// Org-leading, then the cell/arm/day/shard prefix the plan names. The
		// index NAME carries `org` because the key order does; `by_org_send` /
		// `by_org_cell_time` on `sendAssignments` set the same precedent.
		.index('by_org_cell_arm_period_shard', [
			'organizationId',
			'cell',
			'arm',
			'periodStart',
			'shardKey',
		])
		// The aging sweep is deployment-wide (it must not need to enumerate orgs
		// to find old buckets), so it reads the bucket day directly.
		.index('by_period_start', ['periodStart']),
};
