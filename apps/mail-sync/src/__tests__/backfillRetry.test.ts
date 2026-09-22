/**
 * The backfill retry policy — the half of the import that decides whether a run
 * that threw gets another go.
 *
 * The regression this pins is a team-inbox import that failed three times in a
 * row, each time ~60% of the way through a 17,000-message Gmail mailbox. The
 * worker's budget was five consecutive throwing runs, sized against the 5-minute
 * poll loop — but the reconnect path re-invokes the backfill with no delay, so
 * the whole budget went in 72 seconds of reconnect churn, the last two attempts
 * carrying Gmail's own `Account exceeded command or bandwidth limits`.
 */

import { describe, it, expect } from 'vitest';
import {
	MAX_BACKFILL_STRIKES,
	canStartBackfill,
	forMigration,
	initialBackfillRetryState,
	isProviderThrottleError,
	nextBackfillRetryState,
	type BackfillRetryState,
} from '../backfillRetry.js';

const NOW = 1_790_022_005_079;

function stateFor(migrationId: string): BackfillRetryState {
	return forMigration(initialBackfillRetryState(), migrationId);
}

/** ImapFlow's shape when the server killed an in-flight command. */
function noConnectionError(reason?: string): Error {
	const err = new Error('Connection not available') as Error & {
		code: string;
		reason?: string;
	};
	err.code = 'NoConnection';
	if (reason !== undefined) err.reason = reason;
	return err;
}

describe('isProviderThrottleError', () => {
	it("reads Gmail's limit notice off the NoConnection error's reason", () => {
		expect(
			isProviderThrottleError(noConnectionError('Account exceeded command or bandwidth limits.'))
		).toBe(true);
	});

	it('reads it off the message too', () => {
		expect(
			isProviderThrottleError(new Error('[THROTTLED] Your request has been rate limited'))
		).toBe(true);
		expect(isProviderThrottleError(new Error('Too many simultaneous connections'))).toBe(true);
	});

	it('does not read an ordinary drop as throttling', () => {
		expect(isProviderThrottleError(noConnectionError())).toBe(false);
		expect(isProviderThrottleError(new Error('socket hang up'))).toBe(false);
	});
});

describe('retry pacing', () => {
	it('holds the next run back after a failure', () => {
		const { state } = nextBackfillRetryState(
			stateFor('mig_1'),
			{ kind: 'failure', error: noConnectionError(), madeProgress: false },
			NOW
		);
		expect(canStartBackfill(state, NOW)).toBe(false);
		expect(canStartBackfill(state, NOW + 60_000)).toBe(true);
	});

	it('waits far longer when the provider is rate-limiting the account', () => {
		const { state } = nextBackfillRetryState(
			stateFor('mig_1'),
			{
				kind: 'failure',
				error: noConnectionError('Account exceeded command or bandwidth limits.'),
				madeProgress: false,
			},
			NOW
		);
		// Retrying inside a minute cannot succeed against a daily quota, and the
		// fresh FETCHes are what keep the throttle alive.
		expect(state.retryNotBefore - NOW).toBeGreaterThanOrEqual(15 * 60_000);
	});

	it('lets a freshly started migration run immediately, cooldown or not', () => {
		const { state } = nextBackfillRetryState(
			stateFor('mig_1'),
			{
				kind: 'failure',
				error: noConnectionError('Account exceeded command or bandwidth limits.'),
				madeProgress: false,
			},
			NOW
		);
		// The user pressed 'Try again' — that is a new migration row.
		const rebased = forMigration(state, 'mig_2');
		expect(canStartBackfill(rebased, NOW)).toBe(true);
		expect(rebased.strikes).toBe(0);
	});

	it('clears the cooldown and the streak on a clean run', () => {
		const failed = nextBackfillRetryState(
			stateFor('mig_1'),
			{ kind: 'failure', error: noConnectionError(), madeProgress: false },
			NOW
		).state;
		const { state, shouldMarkFailed } = nextBackfillRetryState(failed, { kind: 'success' }, NOW);
		expect(shouldMarkFailed).toBe(false);
		expect(state.strikes).toBe(0);
		expect(canStartBackfill(state, NOW)).toBe(true);
	});
});

describe('strikes', () => {
	it('does not count a run that advanced the walk', () => {
		// The run that died at 20:20:05 had moved 10,397 messages over 90 minutes.
		// An import that is converging is not a stuck one.
		let state = stateFor('mig_1');
		for (let i = 0; i < MAX_BACKFILL_STRIKES * 3; i++) {
			const decision = nextBackfillRetryState(
				state,
				{ kind: 'failure', error: noConnectionError(), madeProgress: true },
				NOW + i * 60_000
			);
			expect(decision.shouldMarkFailed).toBe(false);
			state = decision.state;
		}
		expect(state.strikes).toBe(0);
	});

	it('fails the import once enough runs in a row store nothing', () => {
		let state = stateFor('mig_1');
		let now = NOW;
		const marks: boolean[] = [];
		for (let i = 0; i < MAX_BACKFILL_STRIKES; i++) {
			// Only ever attempted once the cooldown has elapsed.
			now = Math.max(now, state.retryNotBefore);
			expect(canStartBackfill(state, now)).toBe(true);
			const decision = nextBackfillRetryState(
				state,
				{ kind: 'failure', error: new Error('boom'), madeProgress: false },
				now
			);
			marks.push(decision.shouldMarkFailed);
			state = decision.state;
		}
		expect(marks).toEqual([false, false, false, false, true]);
	});

	it('a progressing run in between resets the streak', () => {
		let state = stateFor('mig_1');
		for (let i = 0; i < MAX_BACKFILL_STRIKES - 1; i++) {
			state = nextBackfillRetryState(
				state,
				{ kind: 'failure', error: new Error('boom'), madeProgress: false },
				NOW
			).state;
		}
		expect(state.strikes).toBe(MAX_BACKFILL_STRIKES - 1);
		state = nextBackfillRetryState(
			state,
			{ kind: 'failure', error: noConnectionError(), madeProgress: true },
			NOW
		).state;
		expect(state.strikes).toBe(0);
	});

	it('spends the whole budget over hours, not over a minute of reconnects', () => {
		// The shipped failure, replayed: five drops inside 72 seconds.
		const drops = [
			{ at: NOW, reason: undefined },
			{ at: NOW + 11_683, reason: undefined },
			{ at: NOW + 24_920, reason: undefined },
			{ at: NOW + 46_063, reason: 'Account exceeded command or bandwidth limits.' },
			{ at: NOW + 72_708, reason: 'Account exceeded command or bandwidth limits.' },
		];
		let state = stateFor('mig_1');
		let attempts = 0;
		let markedFailed = false;
		for (const drop of drops) {
			// The connection reopened, so maybeRunBackfill() was called — but the
			// cooldown is what decides whether a run actually starts.
			if (!canStartBackfill(state, drop.at)) continue;
			attempts++;
			const decision = nextBackfillRetryState(
				state,
				{
					kind: 'failure',
					error: noConnectionError(drop.reason),
					madeProgress: false,
				},
				drop.at
			);
			markedFailed ||= decision.shouldMarkFailed;
			state = decision.state;
		}
		// Five reconnects no longer buy five strikes, and the import that was
		// minutes from finishing is still importing.
		expect(attempts).toBeLessThan(drops.length);
		expect(markedFailed).toBe(false);
		// Last drop was Gmail's limit notice, so the next look is hours out.
		expect(state.retryNotBefore - drops[drops.length - 1]!.at).toBeGreaterThanOrEqual(15 * 60_000);
	});

	it('explains a throttled give-up instead of quoting the socket error', () => {
		let state = stateFor('mig_1');
		let decision = nextBackfillRetryState(
			state,
			{
				kind: 'failure',
				error: noConnectionError('Account exceeded command or bandwidth limits.'),
				madeProgress: false,
			},
			NOW
		);
		for (let i = 1; i < MAX_BACKFILL_STRIKES; i++) {
			state = decision.state;
			decision = nextBackfillRetryState(
				state,
				{
					kind: 'failure',
					error: noConnectionError('Account exceeded command or bandwidth limits.'),
					madeProgress: false,
				},
				state.retryNotBefore
			);
		}
		expect(decision.shouldMarkFailed).toBe(true);
		// 'Connection not available' told the user nothing about what to do.
		expect(decision.failureMessage).toContain('rate-limiting');
		expect(decision.failureMessage).toContain('resumes');
	});
});
