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
}

export function initialBackfillRetryState(): BackfillRetryState {
	return { migrationId: null, strikes: 0, retryNotBefore: 0 };
}

/**
 * Rebase the state onto the migration that is importing now. A freshly started
 * import (the wizard's "Try again", or a different account's job arriving on
 * this connection) must never inherit the previous one's strikes or its
 * cooldown — the user pressed the button and expects it to start.
 */
export function forMigration(state: BackfillRetryState, migrationId: string): BackfillRetryState {
	if (state.migrationId === migrationId) return state;
	return { migrationId, strikes: 0, retryNotBefore: 0 };
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
	/** The reason to record when giving up — provider throttling explains itself
	 * far better than the `Connection not available` the IMAP client throws when
	 * the server hangs up on it. */
	failureMessage?: string;
}

export function nextBackfillRetryState(
	state: BackfillRetryState,
	outcome: BackfillRunOutcome,
	now: number
): BackfillRetryDecision {
	if (outcome.kind === 'success') {
		return {
			state: { ...state, strikes: 0, retryNotBefore: 0 },
			shouldMarkFailed: false,
		};
	}

	const throttled = isProviderThrottleError(outcome.error);
	// Advancing the walk clears the streak: the cursor moved, so the next run
	// resumes further along and the import is converging, however many times the
	// connection drops on the way.
	const strikes = outcome.madeProgress ? 0 : state.strikes + 1;
	const shouldMarkFailed = strikes >= MAX_BACKFILL_STRIKES;
	const delay = throttled
		? ladderDelay(THROTTLED_LADDER_MS, Math.max(strikes, 1))
		: outcome.madeProgress
			? PROGRESSED_RETRY_MS
			: ladderDelay(RETRY_LADDER_MS, strikes);

	return {
		state: { ...state, strikes, retryNotBefore: now + delay },
		shouldMarkFailed,
		...(shouldMarkFailed ? { failureMessage: describeFailure(outcome.error, throttled) } : {}),
	};
}

function describeFailure(error: unknown, throttled: boolean): string {
	const message = error instanceof Error ? error.message : String(error);
	if (!throttled) return message;
	return `Your mail provider is rate-limiting this mailbox (${message}). The import stopped where it got to — start it again later and it resumes from there.`;
}
