import type { cronJobs } from 'convex/server';
import { internal } from '../_generated/api';

type Crons = ReturnType<typeof cronJobs>;

/**
 * Team-inbox thread crons. The first two moved here unchanged from
 * `convex/crons.ts` when that file reached the 500-LOC cap (same names,
 * cadences and arguments); the breach sweep and the auto-close sweep joined
 * them.
 */
export function registerTeamInboxCrons(crons: Crons): void {
	// Team-inbox snooze sweep — float snoozed conversation threads back into the
	// Open filter once their snoozedUntil has passed (stamps a "returned" marker).
	crons.interval(
		'inbox wake snoozed threads',
		{ minutes: 1 },
		internal.inbox.snooze.internalSweep,
		{}
	);

	// Thread-presence sweep — delete shared-inbox presence rows whose heartbeat has
	// aged past the 90s active window (tab closed without a clean leave, laptop
	// slept). Keeps threadPresence bounded; presence is read-side only.
	crons.interval(
		'sweep expired thread presence',
		{ minutes: 1 },
		internal.inbox.presence.internalSweep,
		{}
	);

	// Response targets — notify once per clock when a reply deadline passes
	// unanswered (inbox/sla/breaches.ts). A no-op while targets are off.
	crons.interval(
		'inbox flag response target breaches',
		{ minutes: 1 },
		internal.inbox.sla.breaches.sweep,
		{}
	);

	// Auto-close — resolve threads that have waited on the customer for the
	// configured number of quiet days (inbox/autoClose.ts). A no-op while the
	// rule is off. Hourly: the period is counted in days.
	crons.interval(
		'inbox auto-close quiet threads',
		{ hours: 1 },
		internal.inbox.autoClose.sweep,
		{}
	);
}
