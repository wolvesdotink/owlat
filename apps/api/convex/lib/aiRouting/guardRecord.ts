/**
 * D13's "guard required before autonomy" check (ADR-0073).
 *
 * The deterministic injection, smuggling and URL checks run on every Team
 * message. The model guard may be skipped for mail that is archived on its spam
 * score and for mail that arrives while the agent is off; the skip is recorded
 * as `securityFlags.guardNotRun`. Such a message has no semantic injection
 * verdict, so before any later autonomous processing (a retry, a reopen, the
 * agent being switched on and the message re-run) the guard has to run first.
 *
 * `guardUnavailable` is a different state and keeps its existing meaning: the
 * guard ran and failed, drafting proceeds, and the route step refuses auto-send.
 * Pure.
 */

import type { Infer } from 'convex/values';
import type { securityFlagsValidator } from '../convexValidators';

type SecurityFlags = Infer<typeof securityFlagsValidator>;

/**
 * Whether the guard has to run before autonomous work on this message:
 *   - `not_scanned`: no security scan is recorded at all;
 *   - `guard_not_run`: the scan ran its deterministic layers and skipped the model guard;
 *   - `satisfied`: the model guard ran (whatever it found).
 */
export type GuardRequirement = 'satisfied' | 'not_scanned' | 'guard_not_run';

export function guardRequirement(flags: SecurityFlags | undefined): GuardRequirement {
	if (!flags) return 'not_scanned';
	if (flags.guardNotRun) return 'guard_not_run';
	return 'satisfied';
}

/** True unless the model guard has run on this message. */
export function isGuardRequiredBeforeAutonomy(flags: SecurityFlags | undefined): boolean {
	return guardRequirement(flags) !== 'satisfied';
}
