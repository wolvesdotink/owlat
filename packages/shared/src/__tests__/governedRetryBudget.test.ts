import { describe, expect, it } from 'vitest';
import {
	admitGovernedRetry,
	governedDeliveryDeadlineAt,
	nextGovernedAttempt,
	GOVERNED_MTA_MAX_MESSAGE_AGE_MS,
} from '../routingReentry';

/**
 * FIXED TIMESTAMPS, NO CLOCK. Every case below states `now` explicitly, so the
 * boundary matrix is the same on a fast machine, a slow one, and a leap second.
 */
/**
 * The shipped attempt cap, PINNED HERE rather than imported. The predicate keeps
 * it private, and that is the point: a test that reads the module's own constant
 * agrees with any value the module happens to hold, so it could never catch the
 * cap being changed. This literal is the assertion.
 */
const MAX_GOVERNED_ROUTING_ATTEMPTS = 8;

const STARTED_AT = 1_800_000_000_000;
const DEADLINE_AT = STARTED_AT + GOVERNED_MTA_MAX_MESSAGE_AGE_MS;

function verdictAt(attempt: number, now: number, isPolicyHold?: boolean) {
	return admitGovernedRetry(
		{ attempt, startedAt: STARTED_AT },
		now,
		isPolicyHold === undefined ? {} : { isPolicyHold }
	);
}

describe('governedDeliveryDeadlineAt', () => {
	it('is the first attempt plus the one governed message age', () => {
		expect(governedDeliveryDeadlineAt(STARTED_AT)).toBe(DEADLINE_AT);
	});

	it('is the instant every verdict carries, so no caller re-derives it', () => {
		expect(verdictAt(1, STARTED_AT).deadlineAt).toBe(DEADLINE_AT);
		expect(verdictAt(99, DEADLINE_AT + 5).deadlineAt).toBe(DEADLINE_AT);
	});
});

describe('admitGovernedRetry — the attempt cap', () => {
	it('admits every attempt up to and including the last one', () => {
		for (let attempt = 1; attempt <= MAX_GOVERNED_ROUTING_ATTEMPTS; attempt++) {
			const verdict = verdictAt(attempt, STARTED_AT + 1);
			expect(verdict.attempts).toBe('ok');
			expect(verdict.admission).toBe('ok');
		}
	});

	it('refuses the first attempt past the cap', () => {
		const verdict = verdictAt(MAX_GOVERNED_ROUTING_ATTEMPTS + 1, STARTED_AT + 1);
		expect(verdict.attempts).toBe('attempt_capped');
		expect(verdict.admission).toBe('attempt_capped');
	});

	it('reads an ALREADY-INCREMENTED attempt: the cap refuses the successor, not the runner', () => {
		// The dispatch boundary increments before it re-enters, so the value the
		// cap sees for the final attempt's successor is MAX + 1.
		const final = nextGovernedAttempt(MAX_GOVERNED_ROUTING_ATTEMPTS - 1);
		expect(final).toBe(MAX_GOVERNED_ROUTING_ATTEMPTS);
		expect(verdictAt(final, STARTED_AT + 1).attempts).toBe('ok');

		const beyond = nextGovernedAttempt(final);
		expect(beyond).toBe(MAX_GOVERNED_ROUTING_ATTEMPTS + 1);
		expect(verdictAt(beyond, STARTED_AT + 1).attempts).toBe('attempt_capped');
	});

	it('is an exact complement of the completion-side admission at the boundary', () => {
		// Completion admits `attempt <= MAX`; dispatch refuses `attempt > MAX` on
		// the incremented value. The same number must never be admitted by one and
		// refused by the other.
		for (const attempt of [MAX_GOVERNED_ROUTING_ATTEMPTS, MAX_GOVERNED_ROUTING_ATTEMPTS + 1]) {
			const admitted = verdictAt(attempt, STARTED_AT + 1).attempts === 'ok';
			expect(admitted).toBe(attempt <= MAX_GOVERNED_ROUTING_ATTEMPTS);
		}
	});
});

describe('admitGovernedRetry — the cumulative deadline', () => {
	it('admits an age strictly inside the window', () => {
		expect(verdictAt(1, STARTED_AT).deadline).toBe('ok');
		expect(verdictAt(1, DEADLINE_AT - 1).deadline).toBe('ok');
	});

	it('expires AT the deadline, not one tick after it', () => {
		expect(verdictAt(1, DEADLINE_AT).deadline).toBe('deadline_expired');
		expect(verdictAt(1, DEADLINE_AT).admission).toBe('deadline_expired');
		expect(verdictAt(1, DEADLINE_AT + 1).deadline).toBe('deadline_expired');
	});

	it('names a reversed clock rather than calling it expired', () => {
		expect(verdictAt(1, STARTED_AT - 1).deadline).toBe('clock_reversed');
		expect(verdictAt(1, STARTED_AT - GOVERNED_MTA_MAX_MESSAGE_AGE_MS).deadline).toBe(
			'clock_reversed'
		);
	});

	it('reads an infinitely future start as reversed, never as unreadable', () => {
		// `-Infinity` age: the one site that tolerates a reversed clock has always
		// tolerated this too, so it must not fall into the unreadable arm.
		expect(
			admitGovernedRetry({ attempt: 1, startedAt: Number.POSITIVE_INFINITY }, 0).deadline
		).toBe('clock_reversed');
	});

	it('names an unreadable age for NaN and for an infinitely old start', () => {
		expect(admitGovernedRetry({ attempt: 1, startedAt: Number.NaN }, STARTED_AT).deadline).toBe(
			'clock_unreadable'
		);
		expect(
			admitGovernedRetry({ attempt: 1, startedAt: Number.NEGATIVE_INFINITY }, STARTED_AT).deadline
		).toBe('clock_unreadable');
		expect(admitGovernedRetry({ attempt: 1, startedAt: STARTED_AT }, Number.NaN).deadline).toBe(
			'clock_unreadable'
		);
	});

	it('reports the age it judged', () => {
		expect(verdictAt(1, STARTED_AT + 5_000).ageMs).toBe(5_000);
		expect(verdictAt(1, STARTED_AT - 5_000).ageMs).toBe(-5_000);
		expect(Number.isNaN(admitGovernedRetry({ attempt: 1, startedAt: Number.NaN }, 0).ageMs)).toBe(
			true
		);
	});
});

describe('admitGovernedRetry — the policy-hold exemption', () => {
	it('exempts a held message from the attempt cap, and says so', () => {
		const verdict = verdictAt(MAX_GOVERNED_ROUTING_ATTEMPTS + 99, STARTED_AT + 1, true);
		expect(verdict.attempts).toBe('exempt');
		expect(verdict.admission).toBe('ok');
	});

	it('still bounds a held message by the delivery deadline', () => {
		const verdict = verdictAt(1, DEADLINE_AT, true);
		expect(verdict.attempts).toBe('exempt');
		expect(verdict.deadline).toBe('deadline_expired');
		expect(verdict.admission).toBe('deadline_expired');
	});

	it('is off unless asked for: `{}` and `{ isPolicyHold: false }` both spend attempts', () => {
		expect(verdictAt(MAX_GOVERNED_ROUTING_ATTEMPTS + 1, STARTED_AT + 1).attempts).toBe(
			'attempt_capped'
		);
		expect(verdictAt(MAX_GOVERNED_ROUTING_ATTEMPTS + 1, STARTED_AT + 1, false).attempts).toBe(
			'attempt_capped'
		);
	});

	it('does not spend an attempt on the increment side either', () => {
		expect(nextGovernedAttempt(4, { isPolicyHold: true })).toBe(4);
		expect(nextGovernedAttempt(4, { isPolicyHold: false })).toBe(5);
		expect(nextGovernedAttempt(4)).toBe(5);
	});
});

describe('admitGovernedRetry — the collapsed admission', () => {
	it('names the cap ahead of any clock arm when both bounds refuse', () => {
		// The shipped dispatch order: a message that is out of attempts AND out of
		// time is refused for the cap, and its error says so.
		expect(verdictAt(MAX_GOVERNED_ROUTING_ATTEMPTS + 1, DEADLINE_AT).admission).toBe(
			'attempt_capped'
		);
		expect(verdictAt(MAX_GOVERNED_ROUTING_ATTEMPTS + 1, STARTED_AT - 1).admission).toBe(
			'attempt_capped'
		);
		expect(
			admitGovernedRetry(
				{ attempt: MAX_GOVERNED_ROUTING_ATTEMPTS + 1, startedAt: Number.NaN },
				STARTED_AT
			).admission
		).toBe('attempt_capped');
	});

	it('is `ok` only when both bounds admit', () => {
		const matrix: Array<[number, number, boolean]> = [
			[1, STARTED_AT, true],
			[MAX_GOVERNED_ROUTING_ATTEMPTS, DEADLINE_AT - 1, true],
			[MAX_GOVERNED_ROUTING_ATTEMPTS + 1, DEADLINE_AT - 1, false],
			[1, DEADLINE_AT, false],
			[1, STARTED_AT - 1, false],
		];
		for (const [attempt, now, expected] of matrix) {
			expect(verdictAt(attempt, now).admission === 'ok').toBe(expected);
		}
	});
});
