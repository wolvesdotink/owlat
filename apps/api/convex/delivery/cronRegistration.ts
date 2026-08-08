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

	// Relay return-path capability (plan G-08): settle probes that saw no bounce
	// inside the timeout — exactly how a relay that REWRITES our envelope sender
	// presents itself — then re-probe whatever is due, at most two per tick.
	// Idempotent, and backing off (24h → 7d → 30d) because each probe costs the
	// operator a real bounce. With no bring-your-own relay it is a no-op (D2).
	crons.interval(
		'sweep relay return-path probes',
		{ hours: 1 },
		internal.delivery.relayReturnPathProbe.sweepReturnPathProbes,
		{}
	);
	crons.interval(
		'refresh SES relay verification proofs',
		{ hours: 24 },
		internal.domains.sesRelayMutations.scheduleVerificationRefresh,
		{}
	);

	// The same job for the generic relay-identity table (P3.1), and HOURLY rather
	// than daily because the per-domain cadence lives on the row: a domain whose
	// records are not live yet re-checks every hour (that is the screen an
	// operator is watching), a verified one every 24h, a rejected credential
	// every 6h. A daily cron could not honour the shortest of those. A tick with
	// nothing due is one index range read and no writes.
	crons.interval(
		'refresh Mandrill sending-domain identities',
		{ hours: 1 },
		internal.domains.mandrillRelayMutations.scheduleDueChecks,
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
	// Send assignments are one row per recipient per send (the experiment
	// record), so their retention sweep is not optional. 90 days, deleted in
	// bounded indexed batches that resume via self-scheduling while a tick
	// comes back full.
	crons.interval(
		'cleanup send assignments',
		{ hours: 6 },
		internal.delivery.sendAssignments.cleanupExpiredAssignments,
		{}
	);

	// Transport-outcome buckets share the assignment retention horizon (90 days):
	// they are the aggregate the ramp controller reads, and the experiment record
	// they were derived from is gone by then anyway. Sharded per (org, cell, arm,
	// day), so the sweep keeps the per-cell read set bounded.
	crons.interval(
		'cleanup transport outcomes',
		{ hours: 6 },
		internal.analytics.transportOutcomes.cleanupExpiredOutcomes,
		{}
	);

	// THE AIMD RAMP CONTROLLER (plan D13). Convex owns the decision — it has the
	// reputation and outcome data, and it reads MTA state through the existing
	// /ip-reputation sync. Hourly, and BOUNDED per tick: each run takes a slice of
	// the (stream x destinationProvider) grid and self-schedules for the rest.
	//
	// A cell with no stored share is skipped, so on a deployment that never opted
	// into the ramp this cron reads a handful of index misses and writes nothing.
	crons.hourly(
		'evaluate deliverability ramp',
		{ minuteUTC: 40 },
		internal.delivery.rampControllerCron.runRampController,
		{}
	);

	// Ramp decisions share the assignment/outcome retention horizon (90 days):
	// they explain a record that is gone by then anyway.
	crons.interval(
		'cleanup ramp mix decisions',
		{ hours: 6 },
		internal.delivery.rampMixDecisions.cleanupExpiredDecisions,
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

	// Microsoft SNDS: poll the operator's Automated Data Access feeds for per-IP
	// complaint BANDS, spam-trap hits and filter results. Microsoft refreshes the
	// feed a few times a day, so six-hourly is as fresh as the data gets. A
	// deployment with no feed configured is a supported configuration: the poller
	// returns immediately, writes nothing and raises nothing (D2).
	crons.interval(
		'poll Microsoft SNDS data feeds',
		{ hours: 6 },
		internal.delivery.sndsPoll.poll,
		{}
	);

	crons.interval(
		'cleanup Microsoft SNDS telemetry',
		{ hours: 24 },
		internal.delivery.snds.cleanup,
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

	// Gate 5's evidence for the streams that have no campaign to shadow (P4-7).
	// The campaign shadow copy rides a real send, so the `transactional` and
	// `automation` cells had no probes at all and gate 5 held on them forever;
	// this is the plan's "or on a schedule for transactional streams".
	//
	// SIX-HOURLY, while the CADENCE is daily and lives in the sweep itself
	// (`SCHEDULED_SEED_PROBE_INTERVAL_MS`). A tick that finds a cell already
	// probed inside the window costs one indexed read and mails nothing, so the
	// extra ticks buy recovery — a deployment that had no sender configured, no
	// seeds, or an unverified domain at the due moment starts being measured
	// within hours rather than at the next daily slot.
	//
	// With no seed mailboxes connected it is a permanent no-op (D2).
	crons.interval(
		'sweep scheduled seed probes',
		{ hours: 6 },
		internal.delivery.seedScheduledProbe.sweepScheduledSeedProbes,
		{}
	);
}
