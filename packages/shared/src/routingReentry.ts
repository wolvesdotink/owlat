/** One delivery may be deferred by the MTA for up to four days. */
export const GOVERNED_MTA_MAX_MESSAGE_AGE_MS = 4 * 24 * 60 * 60 * 1000;

/** Convex snapshots outlive the MTA queue by this clock/retry safety margin. */
export const ROUTING_REENTRY_CLOCK_SKEW_MS = 60 * 60 * 1000;
export const ROUTING_REENTRY_TOKEN_TTL_MS =
	GOVERNED_MTA_MAX_MESSAGE_AGE_MS + ROUTING_REENTRY_CLOCK_SKEW_MS;

/**
 * Includes the initial attempt. Attempt 8 is terminal and never creates attempt 9.
 *
 * DELIBERATELY MODULE-PRIVATE. Dispatch, completion and routing re-entry each
 * used to import this number and re-spell the comparison, which is how the cap
 * drifted out of step with the deadline beside it. `admitGovernedRetry` is now
 * the only reader; callers ask it for a verdict rather than for the number.
 */
const MAX_GOVERNED_ROUTING_ATTEMPTS = 8;

// AES-GCM ciphertext contains the bound Send/org/attempt locator. Keep this
// bounded at every transport edge without constraining normal Convex IDs.
export const ROUTING_REENTRY_TOKEN_MAX_LENGTH = 512;
export const ROUTING_WORK_ATTEMPT_ID_MAX_LENGTH = 128;

// ============================================================================
// The governed retry budget — ONE predicate for "may this message be sent
// again?", next to the two constants that bound it.
//
// Two independent bounds, never one: a message is admitted while it still has
// attempt budget AND is still inside the cumulative delivery deadline measured
// from its FIRST attempt. Dispatch, completion and routing re-entry each used
// to spell both bounds by hand, which is how the cap and the deadline drifted
// into asking subtly different questions of the same clock.
// ============================================================================

/** The two facts a governed retry budget is decided from. */
export interface GovernedRetryBudgetState {
	/**
	 * 1-based, INCLUSIVE of the initial attempt, and ALREADY INCREMENTED for the
	 * attempt being judged. `MAX_GOVERNED_ROUTING_ATTEMPTS` is the last attempt
	 * that may run, so attempt 9 is the first value the cap refuses.
	 */
	attempt: number;
	/** Wall clock of the FIRST attempt — the cumulative deadline's origin. */
	startedAt: number;
}

export interface GovernedRetryBudgetOptions {
	/**
	 * THE ONE EXEMPTION, STATED RATHER THAN IMPLIED. A deliberate safety hold
	 * (`isPolicyHold` on a routing deferral) consumes no attempt budget: eight
	 * 60-second attempts would terminalize a send ~7 minutes into a pause meant
	 * to outlast them. The dispatch boundary therefore hands a held message its
	 * attempt number UNCHANGED (see `nextGovernedAttempt`), and a cap check on a
	 * held message is `exempt` rather than silently passing — so the exemption is
	 * visible at the predicate, not just at the increment that produced it.
	 *
	 * A hold is bounded by the delivery deadline alone.
	 */
	isPolicyHold?: boolean;
}

/** The attempt-cap bound in isolation. */
export type GovernedAttemptVerdict = 'ok' | 'attempt_capped' | 'exempt';

/**
 * The cumulative-deadline bound in isolation.
 *
 * The two clock arms are NOT decoration: `startedAt` arrives from a token, a
 * workpool result or another host's clock, and "the age is unreadable" is a
 * different claim from "the message ran out of time". Call sites answer them
 * differently on purpose — see the divergence noted in `delivery/sendCompletion.ts`.
 */
export type GovernedDeadlineVerdict =
	| 'ok'
	/** Finite, non-negative age at or past `GOVERNED_MTA_MAX_MESSAGE_AGE_MS`. */
	| 'deadline_expired'
	/** `startedAt` lies in the future (negative age), including `-Infinity`. */
	| 'clock_reversed'
	/** The age is `NaN` or `+Infinity` — no deadline can be computed from it. */
	| 'clock_unreadable';

/** The collapsed admission answer; `ok` only when BOTH bounds admit. */
export type GovernedRetryAdmission =
	| 'ok'
	| 'attempt_capped'
	| 'deadline_expired'
	| 'clock_reversed'
	| 'clock_unreadable';

export interface GovernedRetryBudgetVerdict {
	/**
	 * The single answer, collapsed with the shipped precedence: the attempt cap
	 * is reported ahead of any clock arm, because that is the order the dispatch
	 * boundary has always refused in (a message that is both out of attempts and
	 * out of time names the cap).
	 */
	admission: GovernedRetryAdmission;
	/** The attempt-cap bound alone, for the sites that only ask that. */
	attempts: GovernedAttemptVerdict;
	/** The deadline bound alone, for the sites that only ask that. */
	deadline: GovernedDeadlineVerdict;
	/** `now - startedAt`; may be negative or non-finite, which the arms name. */
	ageMs: number;
	/** The instant this message's cumulative deadline falls. */
	deadlineAt: number;
}

/**
 * THE ONE PLACE THE DELIVERY DEADLINE IS COMPUTED.
 *
 * Measured from the first attempt, so every governed outcome — a deferral, an
 * ambiguous acceptance, a re-entry token's expiry — is bounded by the same
 * instant and no one of them can outlive another.
 */
export function governedDeliveryDeadlineAt(startedAt: number): number {
	return startedAt + GOVERNED_MTA_MAX_MESSAGE_AGE_MS;
}

/**
 * The attempt number the next governed attempt inherits.
 *
 * Lives beside the cap that judges it: a hold that does not spend an attempt
 * and a cap check that exempts a hold are the same rule read from two ends.
 */
export function nextGovernedAttempt(
	attempt: number,
	options: GovernedRetryBudgetOptions = {}
): number {
	return options.isPolicyHold === true ? attempt : attempt + 1;
}

/** May this message still be sent again? Pure — the caller supplies `now`. */
export function admitGovernedRetry(
	state: GovernedRetryBudgetState,
	now: number,
	options: GovernedRetryBudgetOptions = {}
): GovernedRetryBudgetVerdict {
	const ageMs = now - state.startedAt;
	// `ageMs < 0` is asked FIRST so that `-Infinity` reads as a reversed clock
	// rather than an unreadable one: every site that refuses a reversed clock
	// refuses an unreadable one identically, and the one site that tolerates a
	// reversed clock has always tolerated `-Infinity` too.
	const deadline: GovernedDeadlineVerdict =
		ageMs < 0
			? 'clock_reversed'
			: !Number.isFinite(ageMs)
				? 'clock_unreadable'
				: ageMs >= GOVERNED_MTA_MAX_MESSAGE_AGE_MS
					? 'deadline_expired'
					: 'ok';
	const attempts: GovernedAttemptVerdict =
		options.isPolicyHold === true
			? 'exempt'
			: state.attempt > MAX_GOVERNED_ROUTING_ATTEMPTS
				? 'attempt_capped'
				: 'ok';
	return {
		admission: attempts === 'attempt_capped' ? 'attempt_capped' : deadline,
		attempts,
		deadline,
		ageMs,
		deadlineAt: governedDeliveryDeadlineAt(state.startedAt),
	};
}
