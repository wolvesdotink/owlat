/**
 * Cron registration for the seed-placement probe ledger.
 *
 * A domain sibling rather than more lines in the core `crons.ts` (which sits at
 * the ~500 LOC split guideline), following the same shape as
 * `plugins/cronRegistration.ts`: the registrations live next to the functions
 * they schedule and `crons.ts` calls one register function. Only THIS piece's
 * crons live here — every shipped registration stays exactly where it is.
 */

import type { cronJobs } from 'convex/server';
import { internal } from '../_generated/api';

type Crons = ReturnType<typeof cronJobs>;

/**
 * The two seed-probe housekeeping crons.
 *
 * Both are pure housekeeping on the probe LEDGER: neither sends mail, touches a
 * campaign, or can fail a send. With no seed mailboxes connected the ledger is
 * empty and both are no-ops (D2).
 */
export function registerSeedPlacementCrons(crons: Crons): void {
	// One row per shadow copy, retention-bounded at 90 days so the deliverability
	// tripwire never grows without limit (D16).
	crons.interval(
		'cleanup seed placement probes',
		{ hours: 24 },
		internal.analytics.seedProbeLedger.deleteExpiredSeedProbes,
		{}
	);
	// Write off seed probes that were enqueued but never handed to a transport, so
	// an undelivered probe can never be read as a placement `missing`.
	crons.interval(
		'abandon undispatched seed probes',
		{ hours: 6 },
		internal.analytics.seedProbeLedger.abandonUndispatchedSeedProbes,
		{}
	);
}
