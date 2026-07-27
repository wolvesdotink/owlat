/**
 * Cron registration for the analytics domain.
 *
 * A domain sibling rather than more lines in the core `crons.ts` (which sits at
 * the ~500 LOC split guideline), following the same shape as
 * `plugins/cronRegistration.ts`: the registrations for one domain live next to
 * the functions they schedule, and `crons.ts` calls one register function.
 *
 * Cron names, cadences and handlers are exactly the ones `crons.ts` registered
 * before the split — moving a registration between modules changes neither when
 * nor how it runs.
 */

import type { cronJobs } from 'convex/server';
import { internal } from '../_generated/api';

type Crons = ReturnType<typeof cronJobs>;

/** Register every analytics-domain cron. */
export function registerAnalyticsCrons(crons: Crons): void {
	registerSendingReputationCrons(crons);
	registerSeedPlacementCrons(crons);
}

function registerSendingReputationCrons(crons: Crons): void {
	// Clean up sending-reputation buckets older than 60 days every hour (both
	// scopes). Risk is derived on read (ADR-0042), so no periodic recalculation.
	crons.interval(
		'cleanup sending reputation',
		{ hours: 1 },
		internal.analytics.sendingReputation.recalculateAll,
		{}
	);
	// Evaluate the org reputation window hourly and auto-escalate Abuse status
	// when risk is high/critical. Moved off the per-send-event hot path
	// (FIX 3a-1): the wide org-window summarize runs once per cron tick instead
	// of once per recipient. Abuse status dedupes transitions, so the
	// deliverability gate still trips — just on the cron cadence rather than per
	// event.
	crons.interval(
		'evaluate reputation auto-enforce',
		{ hours: 1 },
		internal.analytics.sendingReputation.evaluateAutoEnforce,
		{}
	);
	// Write one daily reputation snapshot (delivery/bounce/complaint rate + sent
	// count of the rolling window) so the Delivery health page has a history to
	// draw its 30-day delivery-rate trend from, and prune points older than ~90
	// days in the same run. `summarize` only derives the current window, so
	// without this cron there is no time series to chart.
	//
	// Anchored to a fixed 00:05 UTC rather than a 24h interval: `crons.interval`
	// re-anchors to deploy/edit time, so a redeploy that drifts across midnight
	// UTC could skip a calendar day and leave a gap in the trend. A fixed daily
	// slot keeps exactly one snapshot per UTC day.
	crons.daily(
		'write delivery snapshot',
		{ hourUTC: 0, minuteUTC: 5 },
		internal.analytics.reputationSnapshots.writeDailySnapshot,
		{}
	);
}

/**
 * The two seed-probe housekeeping crons.
 *
 * Both are pure housekeeping on the probe LEDGER: neither sends mail, touches a
 * campaign, or can fail a send. With no seed mailboxes connected the ledger is
 * empty and both are no-ops (D2).
 */
function registerSeedPlacementCrons(crons: Crons): void {
	// One row per shadow copy, retention-bounded at 90 days so the deliverability
	// tripwire never grows without limit (D16).
	crons.interval(
		'cleanup seed placement probes',
		{ hours: 24 },
		internal.analytics.seedPlacement.deleteExpiredSeedProbes,
		{}
	);
	// Write off seed probes that were enqueued but never handed to a transport, so
	// an undelivered probe can never be read as a placement `missing`.
	crons.interval(
		'abandon undispatched seed probes',
		{ hours: 6 },
		internal.analytics.seedPlacement.abandonUndispatchedSeedProbes,
		{}
	);
}
