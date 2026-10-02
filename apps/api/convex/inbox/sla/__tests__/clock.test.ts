/**
 * The response clock: when a reply deadline starts, pauses, resumes and ends,
 * and how a reply is judged.
 */
import { describe, expect, it } from 'vitest';
import {
	clockOnInbound,
	clockOnReply,
	clockOnStatus,
	pauseClock,
	resumeClock,
	startClock,
	stopClock,
	type SlaPolicyView,
	type ThreadClock,
} from '../clock';

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse('2026-10-01T10:00:00Z');

const policy: SlaPolicyView = {
	firstResponseMs: 2 * HOUR,
	nextResponseMs: 4 * HOUR,
	calendar: { mode: 'calendar', timeZone: 'UTC', businessHours: [], holidays: [] },
};

function thread(overrides: Partial<ThreadClock> = {}): ThreadClock {
	return { status: 'open', ...overrides };
}

describe('startClock', () => {
	it('starts the first-response target on a never-answered thread', () => {
		expect(startClock(thread(), T0, policy)).toMatchObject({
			responseDueAt: T0 + 2 * HOUR,
			responseDueKind: 'first',
			responseClockStartedAt: T0,
		});
	});

	it('uses the next-response target once the team has replied', () => {
		expect(startClock(thread({ firstResponseAt: T0 - HOUR }), T0, policy)).toMatchObject({
			responseDueAt: T0 + 4 * HOUR,
			responseDueKind: 'next',
		});
		// A thread answered before the column existed.
		expect(startClock(thread({ latestDraftStatus: 'sent' }), T0, policy).responseDueKind).toBe(
			'next'
		);
	});

	it('never moves a running deadline and does nothing with targets off', () => {
		expect(startClock(thread({ responseDueAt: T0 + HOUR }), T0 + 30, policy)).toEqual({});
		expect(startClock(thread(), T0, null)).toEqual({});
	});
});

describe('clockOnReply', () => {
	it('records the first reply and judges it on time', () => {
		const patch = clockOnReply(thread({ responseDueAt: T0 + HOUR }), T0, policy);
		expect(patch).toMatchObject({ firstResponseAt: T0, slaMetCount: 1, responseDueAt: undefined });
		expect(patch.slaMissedCount).toBeUndefined();
	});

	it('judges a late reply as a miss and keeps the earliest first reply', () => {
		const patch = clockOnReply(
			thread({ responseDueAt: T0, firstResponseAt: T0 - HOUR, slaMissedCount: 2 }),
			T0 + HOUR,
			policy
		);
		expect(patch).toMatchObject({ firstResponseAt: T0 - HOUR, slaMissedCount: 3 });
	});

	it('judges a paused clock by what was left', () => {
		expect(clockOnReply(thread({ responsePausedRemainingMs: HOUR }), T0, policy).slaMetCount).toBe(
			1
		);
		expect(
			clockOnReply(thread({ responsePausedRemainingMs: -HOUR }), T0, policy).slaMissedCount
		).toBe(1);
	});

	it('records but does not judge while targets are off', () => {
		const patch = clockOnReply(thread({ responseDueAt: T0 - HOUR }), T0, null);
		expect(patch.firstResponseAt).toBe(T0);
		expect(patch.slaMissedCount).toBeUndefined();
	});
});

describe('pause and resume', () => {
	it('keeps the remaining time and moves the deadline out by the pause', () => {
		const paused = pauseClock(thread({ responseDueAt: T0 + HOUR }), T0, policy);
		expect(paused).toEqual({ responseDueAt: undefined, responsePausedRemainingMs: HOUR });
		const resumed = resumeClock(
			thread({ responsePausedRemainingMs: HOUR }),
			T0 + 10 * HOUR,
			policy
		);
		expect(resumed).toEqual({
			responseDueAt: T0 + 11 * HOUR,
			responsePausedRemainingMs: undefined,
		});
	});

	it('resumes an overdue clock as overdue by the same amount', () => {
		const paused = pauseClock(thread({ responseDueAt: T0 - HOUR }), T0, policy);
		expect(paused.responsePausedRemainingMs).toBe(-HOUR);
		expect(
			resumeClock(thread({ responsePausedRemainingMs: -HOUR }), T0 + 5 * HOUR, policy)
		).toEqual({
			responseDueAt: T0 + 4 * HOUR,
			responsePausedRemainingMs: undefined,
		});
	});

	it('clears a paused clock that would resume with targets off', () => {
		expect(resumeClock(thread({ responsePausedRemainingMs: HOUR }), T0, null)).toMatchObject({
			responseDueAt: undefined,
			responsePausedRemainingMs: undefined,
		});
	});

	it('drops the resolve time when a customer message reopens the thread', () => {
		expect(
			clockOnInbound(thread({ status: 'resolved', resolvedAt: T0 - HOUR }), T0, policy)
		).toMatchObject({ resolvedAt: undefined, responseDueAt: T0 + 2 * HOUR });
	});

	it('resumes on a new customer message', () => {
		expect(clockOnInbound(thread({ responsePausedRemainingMs: HOUR }), T0, policy)).toEqual({
			responseDueAt: T0 + HOUR,
			responsePausedRemainingMs: undefined,
		});
	});
});

describe('clockOnStatus', () => {
	it('stops the clock without a verdict when resolved before the deadline', () => {
		const patch = clockOnStatus(thread({ responseDueAt: T0 + HOUR }), 'resolved', T0, policy);
		expect(patch).toMatchObject({ responseDueAt: undefined, resolvedAt: T0 });
		expect(patch.slaMissedCount).toBeUndefined();
	});

	it('keeps a passed deadline a miss when the thread is closed unanswered', () => {
		expect(stopClock(thread({ responseDueAt: T0 - 1 }), T0).slaMissedCount).toBe(1);
	});

	it('pauses on Waiting and resumes on Open, unless still snoozed', () => {
		expect(clockOnStatus(thread({ responseDueAt: T0 + HOUR }), 'waiting', T0, policy)).toEqual({
			responseDueAt: undefined,
			responsePausedRemainingMs: HOUR,
		});
		expect(
			clockOnStatus(
				thread({ status: 'waiting', responsePausedRemainingMs: HOUR }),
				'open',
				T0,
				policy
			)
		).toEqual({ responseDueAt: T0 + HOUR, responsePausedRemainingMs: undefined });
		expect(
			clockOnStatus(
				thread({ status: 'waiting', responsePausedRemainingMs: HOUR, snoozedUntil: T0 + HOUR }),
				'open',
				T0,
				policy
			)
		).toEqual({});
	});

	it('clears the resolve time when the thread reopens', () => {
		expect(
			clockOnStatus(thread({ status: 'resolved', resolvedAt: T0 }), 'open', T0, policy)
		).toEqual({
			resolvedAt: undefined,
		});
	});
});
