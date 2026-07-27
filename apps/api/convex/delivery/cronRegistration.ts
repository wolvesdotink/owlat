/**
 * Delivery-module maintenance crons, registered from the delivery module that
 * owns them.
 *
 * `crons.ts` sat one line under the 500-LOC ratchet
 * (`scripts/check-file-size.sh`), so it could not take another registration at
 * all. Rather than shave a comment to squeeze one more entry in, the delivery
 * schedules move to the module they belong to — the same shape
 * `plugins/cronRegistration.ts` already uses — and `crons.ts` keeps ONE line
 * per domain. `crons.ts` remains the single registration point; this is where
 * the delivery entries live, not a second scheduler.
 */

import type { cronJobs } from 'convex/server';
import { internal } from '../_generated/api';

type Crons = ReturnType<typeof cronJobs>;

/**
 * Register the delivery module's periodic maintenance. Idempotent per
 * deployment: called exactly once, from `crons.ts`.
 */
export function registerDeliveryCrons(crons: Crons): void {
	// Sync IP warming state from MTA every 5 minutes.
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
}
