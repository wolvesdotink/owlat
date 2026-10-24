/**
 * Sender counters: 13 calendar-week buckets, the cohort rule (an
 * open counts in the week its mail was delivered), and the window totals.
 */

import { describe, expect, it } from 'vitest';
import {
	addSenderDelivery,
	addSenderOpen,
	emptySenderWeeks,
	rollSenderWeeks,
	SENDER_WEEK_BUCKETS,
	senderWeekIndex,
	senderWindowTotals,
	utcWeekStart,
	WEEK_MS,
} from '../counters';

// Wednesday 2026-10-14 12:00 UTC; its week starts Monday 2026-10-12.
const WED = Date.UTC(2026, 9, 14, 12);
const MONDAY = Date.UTC(2026, 9, 12);

describe('utcWeekStart', () => {
	it('starts a calendar week on Monday 00:00 UTC', () => {
		expect(utcWeekStart(WED)).toBe(MONDAY);
		expect(utcWeekStart(MONDAY)).toBe(MONDAY);
		// Sunday belongs to the week that started six days earlier.
		expect(utcWeekStart(Date.UTC(2026, 9, 18, 23, 59))).toBe(MONDAY);
		expect(utcWeekStart(Date.UTC(2026, 9, 19))).toBe(MONDAY + WEEK_MS);
	});
});

describe('delivered weeks', () => {
	it('counts into the current week and rolls older weeks back', () => {
		let weeks = emptySenderWeeks(WED);
		weeks = addSenderDelivery(weeks, WED);
		weeks = addSenderDelivery(weeks, WED + 2 * WEEK_MS);
		expect(weeks.weekAnchor).toBe(MONDAY + 2 * WEEK_MS);
		expect(weeks.deliveredWeeks.slice(0, 3)).toEqual([1, 0, 1]);
		expect(weeks.deliveredWeeks).toHaveLength(SENDER_WEEK_BUCKETS);
	});

	it('drops everything after 13 quiet weeks', () => {
		const weeks = addSenderDelivery(emptySenderWeeks(WED), WED);
		const rolled = rollSenderWeeks(weeks, WED + SENDER_WEEK_BUCKETS * WEEK_MS);
		expect(rolled.deliveredWeeks.every((n) => n === 0)).toBe(true);
	});

	it('keeps the anchor when the clock reads earlier (skew)', () => {
		const weeks = addSenderDelivery(emptySenderWeeks(WED), WED);
		expect(rollSenderWeeks(weeks, WED - WEEK_MS).weekAnchor).toBe(MONDAY);
	});
});

describe('the cohort rule', () => {
	it('counts an open in the week the mail was delivered, not the week it was opened', () => {
		let weeks = addSenderDelivery(emptySenderWeeks(WED), WED);
		weeks = addSenderOpen(weeks, WED, WED + 3 * WEEK_MS);
		expect(weeks.openedWeeks[3]).toBe(1);
		expect(weeks.openedWeeks[0]).toBe(0);
	});

	it('never counts more opens than deliveries in a week', () => {
		let weeks = addSenderDelivery(emptySenderWeeks(WED), WED);
		weeks = addSenderOpen(weeks, WED, WED);
		weeks = addSenderOpen(weeks, WED, WED);
		expect(weeks.openedWeeks[0]).toBe(1);
	});

	it('does not count an open of mail older than the window', () => {
		const delivered = addSenderDelivery(emptySenderWeeks(WED), WED);
		const later = WED + SENDER_WEEK_BUCKETS * WEEK_MS;
		const weeks = addSenderOpen(delivered, WED, later);
		expect(weeks.openedWeeks.every((n) => n === 0)).toBe(true);
		expect(senderWeekIndex(weeks, WED)).toBeNull();
	});
});

describe('senderWindowTotals', () => {
	it('reads delivered, opened and the rate over the window as of now', () => {
		let weeks = emptySenderWeeks(WED);
		for (let i = 0; i < 4; i++) weeks = addSenderDelivery(weeks, WED);
		weeks = addSenderOpen(weeks, WED, WED);
		expect(senderWindowTotals(weeks, WED)).toEqual({ delivered: 4, opened: 1, readRate: 0.25 });
		expect(senderWindowTotals(emptySenderWeeks(WED), WED).readRate).toBe(0);
	});
});
