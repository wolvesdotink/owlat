import { describe, expect, it } from 'vitest';
import {
	autoCloseColumnsOnStatus,
	autoCloseCutoff,
	autoCloseDaysProblem,
	autoCloseDueAt,
	autoClosePolicyView,
	isAutoCloseDue,
	quietSince,
} from '../autoCloseRules';

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_000 * DAY;
const policy = { quietDays: 3, enabledAt: T0 - 100 * DAY };

const waiting = {
	status: 'waiting' as const,
	lastMessageAt: T0 - 2 * DAY,
	waitingSince: T0,
};

describe('autoCloseDaysProblem', () => {
	it('accepts whole days from 1 to 365', () => {
		expect(autoCloseDaysProblem(1)).toBeNull();
		expect(autoCloseDaysProblem(365)).toBeNull();
	});
	it.each([0, 366, 2.5, -3, Number.NaN, Number.POSITIVE_INFINITY])('refuses %s', (days) => {
		expect(autoCloseDaysProblem(days)).not.toBeNull();
	});
});

describe('autoClosePolicyView', () => {
	it('is null when absent, off, or holding unusable days', () => {
		expect(autoClosePolicyView(null)).toBeNull();
		expect(
			autoClosePolicyView({ isEnabled: false, quietDays: 3, enabledAt: T0, updatedAt: T0 })
		).toBeNull();
		expect(
			autoClosePolicyView({ isEnabled: true, quietDays: 0, enabledAt: T0, updatedAt: T0 })
		).toBeNull();
	});
	it('falls back to the save time when no switch-on time was stamped', () => {
		expect(autoClosePolicyView({ isEnabled: true, quietDays: 4, updatedAt: T0 })).toEqual({
			quietDays: 4,
			enabledAt: T0,
		});
	});
});

describe('quietSince', () => {
	it('is the latest of every signal that restarts the silence', () => {
		expect(quietSince(waiting, policy)).toBe(T0);
		expect(quietSince({ ...waiting, lastReplySentAt: T0 + 1 }, policy)).toBe(T0 + 1);
		expect(quietSince({ ...waiting, snoozeReturnedAt: T0 + 2 }, policy)).toBe(T0 + 2);
		expect(quietSince({ ...waiting, snoozedUntil: T0 + 5 }, policy)).toBe(T0 + 5);
		expect(quietSince({ ...waiting, autoCloseRestartedAt: T0 + 3 }, policy)).toBe(T0 + 3);
		expect(quietSince(waiting, { ...policy, enabledAt: T0 + 4 })).toBe(T0 + 4);
		// A thread that waited before the stamp existed: its last message.
		expect(quietSince({ ...waiting, waitingSince: undefined }, policy)).toBe(T0 - 2 * DAY);
	});
});

describe('autoCloseDueAt / isAutoCloseDue', () => {
	it('is due N days after the silence began, not a moment before', () => {
		expect(autoCloseDueAt(waiting, policy)).toBe(T0 + 3 * DAY);
		expect(isAutoCloseDue(waiting, policy, T0 + 3 * DAY - 1)).toBe(false);
		expect(isAutoCloseDue(waiting, policy, T0 + 3 * DAY)).toBe(true);
	});
	it('never, while off, not waiting or opted out', () => {
		expect(autoCloseDueAt(waiting, null)).toBeNull();
		expect(autoCloseDueAt({ ...waiting, status: 'open' }, policy)).toBeNull();
		expect(autoCloseDueAt({ ...waiting, status: 'resolved' }, policy)).toBeNull();
		expect(autoCloseDueAt({ ...waiting, isAutoCloseDisabled: true }, policy)).toBeNull();
	});
	it('counts a snooze still on the row from its deadline', () => {
		// The snooze cron has not woken it yet: the fresh quiet period still
		// starts at the deadline, not at whichever cron runs first.
		const snoozed = { ...waiting, snoozedUntil: T0 + 10 * DAY };
		expect(autoCloseDueAt(snoozed, policy)).toBe(T0 + 13 * DAY);
		expect(isAutoCloseDue(snoozed, policy, T0 + 5 * DAY)).toBe(false);
		expect(isAutoCloseDue(snoozed, policy, T0 + 10 * DAY)).toBe(false);
		expect(isAutoCloseDue(snoozed, policy, T0 + 13 * DAY - 1)).toBe(false);
		expect(isAutoCloseDue(snoozed, policy, T0 + 13 * DAY)).toBe(true);
		// Once woken, from the wake.
		const woken = { ...waiting, snoozeReturnedAt: T0 + 10 * DAY + 1 };
		expect(autoCloseDueAt(woken, policy)).toBe(T0 + 13 * DAY + 1);
	});
	it('bounds the sweep at the newest last message a due thread can have', () => {
		expect(autoCloseCutoff(policy, T0)).toBe(T0 - 3 * DAY);
	});
});

describe('autoCloseColumnsOnStatus', () => {
	it('stamps entering waiting and clears leaving it', () => {
		expect(autoCloseColumnsOnStatus({ status: 'open' }, 'waiting', T0)).toEqual({
			waitingSince: T0,
		});
		expect(autoCloseColumnsOnStatus({ status: 'waiting', waitingSince: T0 }, 'open', T0)).toEqual({
			waitingSince: undefined,
		});
	});
	it('ends the automatic-close provenance on any real edge', () => {
		expect(
			autoCloseColumnsOnStatus(
				{ status: 'resolved', autoClosedAt: T0, autoClosedQuietDays: 3 },
				'open',
				T0 + 1
			)
		).toEqual({ autoClosedAt: undefined, autoClosedQuietDays: undefined });
	});
	it('changes nothing on a non-edge', () => {
		expect(
			autoCloseColumnsOnStatus({ status: 'waiting', waitingSince: T0 }, 'waiting', T0)
		).toEqual({});
	});
});
