/**
 * Team Inbox waiting time as the row renders it (utils/inboxWaiting): who is
 * waiting on us, the escalation tiers, and the chip's message shape.
 *
 * The rule is mirrored from apps/api/convex/inbox/threadSort.ts (which owns the
 * pill's count and its index range); the 24h escalation is pinned on both sides
 * so a change to one shows up as a failure, not as a pill that counts three
 * while two rows look overdue.
 */
import { describe, it, expect } from 'vitest';
import {
	INBOX_WAITING_ATTENTION_MS,
	INBOX_WAITING_OVER_24H_MS,
	INBOX_WAITING_TIER_CLASS,
	inboxWaitingChip,
	inboxWaitingLabel,
	inboxWaitingMs,
	inboxWaitingTier,
	isWaitingOnUs,
	type InboxWaitingThread,
} from '../inboxWaiting';

const NOW = 1_700_000_000_000;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function thread(overrides: Partial<InboxWaitingThread> = {}): InboxWaitingThread {
	return { status: 'open', lastMessageAt: NOW - HOUR, ...overrides };
}

describe('isWaitingOnUs', () => {
	it('counts an open, un-snoozed thread', () => {
		expect(isWaitingOnUs(thread(), NOW)).toBe(true);
	});

	it('does not count a thread waiting on the CUSTOMER, or finished work', () => {
		expect(isWaitingOnUs(thread({ status: 'waiting' }), NOW)).toBe(false);
		expect(isWaitingOnUs(thread({ status: 'resolved' }), NOW)).toBe(false);
		expect(isWaitingOnUs(thread({ status: 'closed' }), NOW)).toBe(false);
	});

	it('does not count a deliberate "not now", but does count a lapsed one', () => {
		expect(isWaitingOnUs(thread({ snoozedUntil: NOW + HOUR }), NOW)).toBe(false);
		expect(isWaitingOnUs(thread({ snoozedUntil: NOW - HOUR }), NOW)).toBe(true);
		expect(isWaitingOnUs(thread({ snoozedUntil: null }), NOW)).toBe(true);
	});

	it('reports no wait for a row with no inbound timestamp at all', () => {
		// Counting from the epoch would render "waiting 19000d" on a fresh row.
		expect(isWaitingOnUs(thread({ lastMessageAt: null }), NOW)).toBe(false);
		expect(inboxWaitingMs(thread({ lastMessageAt: undefined }), NOW)).toBeNull();
	});
});

describe('inboxWaitingMs', () => {
	it('measures from the newest inbound activity', () => {
		expect(inboxWaitingMs(thread({ lastMessageAt: NOW - 3 * HOUR }), NOW)).toBe(3 * HOUR);
	});

	it('is null for anything not waiting on us', () => {
		expect(inboxWaitingMs(thread({ status: 'resolved' }), NOW)).toBeNull();
	});

	it('clamps a future timestamp rather than reporting a negative wait', () => {
		expect(inboxWaitingMs(thread({ lastMessageAt: NOW + HOUR }), NOW)).toBe(0);
	});
});

describe('inboxWaitingTier', () => {
	it('mirrors the server escalation exactly', () => {
		expect(INBOX_WAITING_OVER_24H_MS).toBe(24 * 60 * 60 * 1000);
	});

	it('escalates at each boundary, inclusive', () => {
		expect(inboxWaitingTier(0)).toBe('fresh');
		expect(inboxWaitingTier(INBOX_WAITING_ATTENTION_MS - 1)).toBe('fresh');
		expect(inboxWaitingTier(INBOX_WAITING_ATTENTION_MS)).toBe('attention');
		expect(inboxWaitingTier(INBOX_WAITING_OVER_24H_MS - 1)).toBe('attention');
		expect(inboxWaitingTier(INBOX_WAITING_OVER_24H_MS)).toBe('overdue');
	});

	it('gives every tier its own class, so escalation is visible', () => {
		const classes = Object.values(INBOX_WAITING_TIER_CLASS);
		expect(new Set(classes).size).toBe(classes.length);
	});
});

describe('inboxWaitingLabel', () => {
	it('reads in minutes under an hour', () => {
		expect(inboxWaitingLabel(5 * MINUTE)).toEqual({
			key: 'shared.inboxWaiting.minutes',
			params: { minutes: 5 },
		});
	});

	it('reads in hours under a day', () => {
		expect(inboxWaitingLabel(5 * HOUR + 30 * MINUTE)).toEqual({
			key: 'shared.inboxWaiting.hours',
			params: { hours: 5 },
		});
	});

	it('reads in days plus hours past a day', () => {
		expect(inboxWaitingLabel(3 * DAY + 2 * HOUR)).toEqual({
			key: 'shared.inboxWaiting.daysHours',
			params: { days: 3, hours: 2 },
		});
	});

	it('drops a zero hour rather than rendering "3d 0h"', () => {
		expect(inboxWaitingLabel(3 * DAY + 4 * MINUTE)).toEqual({
			key: 'shared.inboxWaiting.days',
			params: { days: 3 },
		});
	});

	it('returns a key and params, never an assembled sentence', () => {
		for (const ms of [MINUTE, HOUR, DAY, 3 * DAY + HOUR]) {
			expect(inboxWaitingLabel(ms).key).toMatch(/^shared\.inboxWaiting\./);
		}
	});
});

describe('inboxWaitingChip', () => {
	it('is null when the thread is not waiting on us', () => {
		expect(inboxWaitingChip(thread({ status: 'waiting' }), NOW)).toBeNull();
		expect(inboxWaitingChip(thread({ snoozedUntil: NOW + DAY }), NOW)).toBeNull();
	});

	it('carries the tier and the label together', () => {
		expect(inboxWaitingChip(thread({ lastMessageAt: NOW - 3 * DAY - 2 * HOUR }), NOW)).toEqual({
			tier: 'overdue',
			label: { key: 'shared.inboxWaiting.daysHours', params: { days: 3, hours: 2 } },
			waitedMs: 3 * DAY + 2 * HOUR,
		});
	});
});
