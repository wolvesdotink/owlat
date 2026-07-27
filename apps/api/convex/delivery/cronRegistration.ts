import type { cronJobs } from 'convex/server';
import { internal } from '../_generated/api';

type Crons = ReturnType<typeof cronJobs>;

/**
 * Register every delivery / deliverability cron on the instance's cron table.
 *
 * These registrations used to sit inline in `convex/crons.ts` as a flat list of
 * a dozen entries with long rationale comments, which is what pushed that file
 * against the 500-LOC cap. Extracting them mirrors
 * `plugins/cronRegistration.ts`: `crons.ts` stays a short index of WHAT runs,
 * and the delivery domain owns the WHEN and WHY of its own schedule. Pure move —
 * every cron keeps its name, cadence and arguments, so no schedule changes.
 */
export function registerDeliveryCrons(crons: Crons): void {
	// Sync IP warming state from MTA every 5 minutes
	crons.interval(
		'sync warming state',
		{ minutes: 5 },
		internal.delivery.warmingSync.syncWarmingState
	);
	crons.interval(
		'cleanup deliverability route state',
		{ minutes: 5 },
		internal.delivery.deliverabilityRouting.cleanupExpired,
		{}
	);

	// Keep the built-in MTA's infrastructure readiness visible to reactive
	// Delivery surfaces. The MTA internally caches its TCP/25 probes, so this
	// cadence does not create a connection storm against the probe target.
	crons.interval('sync MTA health', { minutes: 2 }, internal.delivery.mtaHealth.sync, {});
	crons.interval(
		'refresh SES relay verification proofs',
		{ hours: 24 },
		internal.domains.sesRelayMutations.scheduleVerificationRefresh,
		{}
	);

	// Clean up sending-reputation buckets older than 60 days every hour (both
	// scopes). Risk is derived on read (ADR-0042), so no periodic recalculation.
	crons.interval(
		'cleanup sending reputation',
		{ hours: 1 },
		internal.analytics.sendingReputation.recalculateAll,
		{}
	);

	crons.interval(
		'cleanup delivery compliance telemetry',
		{ hours: 1 },
		internal.delivery.complianceTelemetry.cleanupComplianceTelemetry,
		{}
	);
	crons.interval(
		'cleanup MTA IP readiness alerts',
		{ hours: 24 },
		internal.delivery.ipReadinessAlerts.cleanupExpired,
		{}
	);

	crons.interval(
		'cleanup Google Postmaster telemetry',
		{ hours: 24 },
		internal.delivery.postmaster.cleanup,
		{}
	);

	crons.interval(
		'check critical deliverability DNS and blocklists',
		{ hours: 1 },
		internal.delivery.checklistSweep.runHourly,
		{}
	);

	crons.interval(
		'check complete deliverability posture',
		{ hours: 24 },
		internal.delivery.checklistSweep.runDaily,
		{}
	);

	// Evaluate the org reputation window hourly and auto-escalate Abuse status when
	// risk is high/critical. Moved off the per-send-event hot path (FIX 3a-1): the
	// wide org-window summarize runs once per cron tick instead of once per
	// recipient. Abuse status dedupes transitions, so the deliverability gate still
	// trips — just on the cron cadence rather than per event.
	crons.interval(
		'evaluate reputation auto-enforce',
		{ hours: 1 },
		internal.analytics.sendingReputation.evaluateAutoEnforce,
		{}
	);

	// Write one daily reputation snapshot (delivery/bounce/complaint rate + sent
	// count of the rolling window) so the Delivery health page has a history to
	// draw its 30-day delivery-rate trend from, and prune points older than ~90
	// days in the same run. `summarize` only derives the current window, so without
	// this cron there is no time series to chart.
	//
	// Anchored to a fixed 00:05 UTC rather than a 24h interval: `crons.interval`
	// re-anchors to deploy/edit time, so a redeploy that drifts across midnight UTC
	// could skip a calendar day and leave a gap in the trend. A fixed daily slot
	// keeps exactly one snapshot per UTC day.
	crons.daily(
		'write delivery snapshot',
		{ hourUTC: 0, minuteUTC: 5 },
		internal.analytics.reputationSnapshots.writeDailySnapshot,
		{}
	);

	// Re-verify dual-transport alignment (P3-5): the two arms of a ramp cell must
	// stay indistinguishable to the receiver (same From domain, one SPF record
	// inside the 10-lookup limit, same DKIM d= with distinct selectors, DMARC
	// alignment on both), or the ramp measures our own DNS instead of
	// deliverability.
	//
	// HOURLY, not daily: the per-domain cadence lives in `nextCheckDueAt` — 24h
	// after a resolved verdict, ~1h after an unresolved lookup
	// (ALIGNMENT_UNKNOWN_RETRY_MS) — and a daily cron could never honour the shorter
	// one. A domain that is not due costs one indexed read, so the hourly tick is
	// cheap; each run is bounded by page count and continues from a cursor.
	//
	// With no reference transport the verdict is `single_arm` — a supported
	// configuration, never an error.
	crons.hourly(
		'verify dual-transport alignment',
		{ minuteUTC: 20 },
		internal.delivery.alignmentPreflightGather.runAlignmentPreflightSweep,
		{}
	);
}
