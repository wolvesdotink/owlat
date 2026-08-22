import type { cronJobs } from 'convex/server';
import { internal } from '../_generated/api';

type Crons = ReturnType<typeof cronJobs>;

/**
 * The two observer crons, registered from the OSTR domain the way
 * `delivery/cronRegistration.ts` and `contacts/crons.ts` do — `crons.ts` stays
 * a short index of WHAT runs and the domain owns the WHEN and WHY.
 *
 * Both are unconditional registrations of conditional work: observer mode is
 * env-gated, and the environment is not readable at cron-registration time
 * (registration happens at push, the flag is read at execution). Each job's
 * first act is therefore to check eligibility and return, so on the shipped
 * default deployment these are two no-op ticks a day plus one an hour.
 */
export function registerOstrCrons(crons: Crons): void {
	// Close the observation window: aggregate the hour's DKIM-verified traffic,
	// emit what clears the §7.4 k-floor, pair emitted summaries with their
	// queued spam reports, log any newly-seen DKIM key, sign and cross-submit.
	// Hourly matches the window length — a tick that finds no whole closed
	// window returns immediately.
	crons.interval(
		'ostr close observation window',
		{ hours: 1 },
		internal.ostr.window.closeWindow,
		{}
	);

	// The §7.2 retention cutoff: evidence bundles, their dedupe entries, and
	// settled submissions past ~90 days. Daily, alongside the other PII sweeps.
	crons.interval(
		'retention: ostr observer evidence',
		{ hours: 24 },
		internal.ostr.retention.pruneObserverData,
		{}
	);
}
