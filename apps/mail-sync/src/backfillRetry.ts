/**
 * When a historical backfill that threw is worth another run, and when it is
 * genuinely stuck.
 *
 * `connection.ts` used to count CONSECUTIVE throwing runs and give up at five.
 * That number was chosen against the periodic poll loop, which re-invokes the
 * backfill once every `folderPollIntervalMs` (5 minutes by default), so five
 * strikes were meant to span ~25 minutes of sustained failure. But the
 * reconnect path also re-invokes it — `client.on('close')` → `scheduleReconnect`
 * → `connectOnce` → `maybeRunBackfill` — with no delay at all. So a provider
 * that drops the connection, is reconnected to, and drops it again spends the
 * whole budget in about a minute:
 *
 *     20:20:05  backfill failed  failures=1   ← 90 minutes and 10,397 messages in
 *     20:20:16  backfill failed  failures=2
 *     20:20:29  backfill failed  failures=3
 *     20:20:51  backfill failed  failures=4   reason: Account exceeded command
 *                                                     or bandwidth limits.
 *     20:21:17  backfill failed  failures=5
 *     20:21:17  backfill failed repeatedly; marking migration import as failed
 *
 * Two things are wrong there and both live here now:
 *
 *  1. Nothing paced the retries, so the budget measured reconnects rather than
 *     time. Every decision this module returns carries a `retryNotBefore`, and
 *     the caller starts no new run before it.
 *  2. The run that moved 10,397 messages counted exactly like the four that
 *     threw within seconds of opening. A run that ADVANCED THE WALK is an
 *     import making progress, not a stuck one, so it clears the streak; only
 *     runs that store nothing and move no cursor accrue strikes.
 *
 * Provider throttling gets its own, much longer ladder. "Account exceeded
 * command or bandwidth limits" is Gmail saying come back later — it is a
 * duration, not a defect, and hammering a throttled account with fresh FETCHes
 * is what keeps the throttle alive.
 *
 * And a throttled walk that exhausts that ladder is not failed either. The
 * ladder spans a few hours; a provider's bandwidth cap is measured over a
 * rolling day. A mailbox larger than one day's budget used to exhaust the
 * ladder every single day and land on a red "import stopped" card the user had
 * to notice and restart, once per day of mail. A throttled give-up is now a
 * PAUSE: the decision carries a `resumeAt` a full window after the throttle
 * began, the caller records it on the migration, and the walk picks itself up
 * when it passes. `failed` stays for the walks that will not heal by waiting.
 *
 * Pure (no ImapFlow / Convex imports) so the policy is unit-testable on its own;
 * `connection.ts` holds the state and applies the decisions.
 */

/** How many consecutive runs may store nothing before the import is failed. */
export const MAX_BACKFILL_STRIKES = 5;

/**
 * Delay before the next attempt, indexed by strike count. A drop that is not
 * the provider rate-limiting us is usually a one-off (idle timeout, a reset
 * socket), so the first retry is quick and the ladder only stretches once the
 * failure looks sustained.
 */
const RETRY_LADDER_MS = [60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000, 15 * 60_000];

/**
 * The same ladder for a throttled account. A provider quota is measured in
 * hours (Gmail's IMAP bandwidth cap resets daily), so retrying inside a minute
 * cannot succeed and only deepens the throttle.
 */
const THROTTLED_LADDER_MS = [
	15 * 60_000,
	30 * 60_000,
	60 * 60_000,
	2 * 60 * 60_000,
	2 * 60 * 60_000,
];

/**
 * How long a throttled import waits once the ladder above is spent. Gmail's
 * IMAP bandwidth cap is a rolling 24-hour window and reports no reset time, so
 * a full window measured from the first throttled run is the soonest the
 * budget is certain to be back.
 */
export const THROTTLE_PAUSE_MS = 24 * 60 * 60_000;

/**
 * After a run that DID advance the walk. Long enough that a provider dropping
 * us every few batches cannot turn into a reconnect storm, short enough that a
 * multi-hour import is not paced by this number.
 */
const PROGRESSED_RETRY_MS = 60_000;

function ladderDelay(ladder: readonly number[], strikes: number): number {
	const i = Math.min(Math.max(strikes, 1), ladder.length) - 1;
	return ladder[i] ?? ladder[ladder.length - 1] ?? PROGRESSED_RETRY_MS;
}

/**
 * The provider is rate-limiting this account — a "later", not a fault.
 *
 * Matched off the message because that is all the IMAP client surfaces: the
 * server's BYE/NO text arrives as `err.message` or, when it killed an in-flight
 * command, as the `reason` on the `NoConnection` error ImapFlow then throws.
 * Both are folded into the string this reads.
 */
export function isProviderThrottleError(error: unknown): boolean {
	const parts: string[] = [];
	if (error instanceof Error) parts.push(error.message);
	else parts.push(String(error));
	const reason = (error as { reason?: unknown } | null)?.reason;
	if (typeof reason === 'string') parts.push(reason);
	const msg = parts.join(' ').toLowerCase();
	return (
		// Gmail, when an IMAP session has spent the account's daily bandwidth or
		// command budget.
		msg.includes('exceeded command or bandwidth limits') ||
		msg.includes('too many simultaneous connections') ||
		msg.includes('[overquota]') ||
		msg.includes('[throttled]') ||
		msg.includes('[limit]') ||
		msg.includes('rate limit') ||
		msg.includes('try again later')
	);
}

/** Per-migration retry bookkeeping. Owned by the caller, advanced here. */
export interface BackfillRetryState {
	/** Which migration the streak belongs to; a different one starts over. */
	migrationId: string | null;
	/** Consecutive runs that failed WITHOUT advancing the walk. */
	strikes: number;
	/** Epoch ms before which no new run may start. */
	retryNotBefore: number;
	/** When the provider first throttled the current streak (null when it has
	 * not). A pause is measured from here, because that is when the budget ran
	 * out — not from the end of the ladder, hours later. */
	throttledSince: number | null;
}

export function initialBackfillRetryState(): BackfillRetryState {
	return { migrationId: null, strikes: 0, retryNotBefore: 0, throttledSince: null };
}

/**
 * Rebase the state onto the migration that is importing now. A freshly started
 * import (the wizard's "Try again", or a different account's job arriving on
 * this connection) must never inherit the previous one's strikes or its
 * cooldown — the user pressed the button and expects it to start.
 */
export function forMigration(state: BackfillRetryState, migrationId: string): BackfillRetryState {
	if (state.migrationId === migrationId) return state;
	return { migrationId, strikes: 0, retryNotBefore: 0, throttledSince: null };
}

/** Whether a run may start now. */
export function canStartBackfill(state: BackfillRetryState, now: number): boolean {
	return now >= state.retryNotBefore;
}

/** What one finished run was. */
export type BackfillRunOutcome =
	| { kind: 'success' }
	| {
			kind: 'failure';
			error: unknown;
			/** Did this run persist at least one batch of progress? */
			madeProgress: boolean;
	  };

export interface BackfillRetryDecision {
	state: BackfillRetryState;
	/** Give up: transition the migration to `failed`. */
	shouldMarkFailed: boolean;
	/** The provider's budget is spent: hold the migration until `resumeAt` rather
	 * than failing it. Never set together with `shouldMarkFailed`. */
	shouldPause: boolean;
	/** Epoch ms the paused walk picks up again (set when `shouldPause`). */
	resumeAt?: number;
}

export function nextBackfillRetryState(
	state: BackfillRetryState,
	outcome: BackfillRunOutcome,
	now: number
): BackfillRetryDecision {
	if (outcome.kind === 'success') {
		return {
			state: { ...state, strikes: 0, retryNotBefore: 0, throttledSince: null },
			shouldMarkFailed: false,
			shouldPause: false,
		};
	}

	const throttled = isProviderThrottleError(outcome.error);
	// Advancing the walk clears the streak: the cursor moved, so the next run
	// resumes further along and the import is converging, however many times the
	// connection drops on the way.
	const strikes = outcome.madeProgress ? 0 : state.strikes + 1;
	// A pause is measured from when the budget ran out. A run that moved the
	// walk and was then cut off is that moment, so it restarts the clock; a
	// zero-progress throttle keeps the clock its streak already started.
	let throttledSince = outcome.madeProgress ? null : state.throttledSince;
	if (throttled) throttledSince ??= now;
	const exhausted = strikes >= MAX_BACKFILL_STRIKES;

	if (exhausted && throttled) {
		// The ladder is spent against a provider that is still saying "later".
		// Waiting out its window is the fix, so wait — with a fresh ladder for the
		// run that follows.
		const resumeAt = Math.max(
			(throttledSince ?? now) + THROTTLE_PAUSE_MS,
			now + ladderDelay(THROTTLED_LADDER_MS, THROTTLED_LADDER_MS.length)
		);
		return {
			state: { ...state, strikes: 0, retryNotBefore: resumeAt, throttledSince: null },
			shouldMarkFailed: false,
			shouldPause: true,
			resumeAt,
		};
	}

	const delay = throttled
		? ladderDelay(THROTTLED_LADDER_MS, Math.max(strikes, 1))
		: outcome.madeProgress
			? PROGRESSED_RETRY_MS
			: ladderDelay(RETRY_LADDER_MS, strikes);

	return {
		state: { ...state, strikes, retryNotBefore: now + delay, throttledSince },
		shouldMarkFailed: exhausted,
		shouldPause: false,
	};
}

/** The reason recorded alongside a pause — the provider's own words, for the
 * audit log. */
export function describeThrottle(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const reason = (error as { reason?: unknown } | null)?.reason;
	return typeof reason === 'string' && reason !== message ? `${message}: ${reason}` : message;
}
