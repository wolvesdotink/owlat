/**
 * Team Inbox waiting time (inbox/threadSort): who is waiting on us, for how
 * long, and the "oldest waiting" order.
 *
 * The whole derivation rests on one invariant of the thread module:
 * `lastMessageAt` is bumped ONLY by the `inbound_activity` reducer, so it is
 * the newest message THEY sent. inbox/threads/__tests__/module.test.ts owns
 * that invariant; this suite owns the rule built on it.
 */
import { describe, it, expect } from 'vitest';
import {
	WAITING_OVER_24H_MS,
	compareOldestWaiting,
	isWaitingOnUs,
	isWaitingOver24h,
	waitingMs,
	type WaitingThread,
} from '../threadSort';

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

function t(overrides: Partial<WaitingThread> = {}): WaitingThread {
	return { status: 'open', lastMessageAt: NOW - HOUR, ...overrides };
}

describe('isWaitingOnUs', () => {
	it('counts an open, un-snoozed thread', () => {
		expect(isWaitingOnUs(t(), NOW)).toBe(true);
	});

	it('does not count a thread waiting on the CUSTOMER', () => {
		expect(isWaitingOnUs(t({ status: 'waiting' }), NOW)).toBe(false);
	});

	it('does not count finished work', () => {
		expect(isWaitingOnUs(t({ status: 'resolved' }), NOW)).toBe(false);
		expect(isWaitingOnUs(t({ status: 'closed' }), NOW)).toBe(false);
	});

	it('does not count a deliberate "not now"', () => {
		expect(isWaitingOnUs(t({ snoozedUntil: NOW + HOUR }), NOW)).toBe(false);
	});

	it('counts a snooze that has already lapsed', () => {
		expect(isWaitingOnUs(t({ snoozedUntil: NOW - HOUR }), NOW)).toBe(true);
	});
});

describe('waitingMs', () => {
	it('measures from the newest inbound activity', () => {
		expect(waitingMs(t({ lastMessageAt: NOW - 3 * HOUR }), NOW)).toBe(3 * HOUR);
	});

	it('is null for a thread that is not waiting on us', () => {
		expect(waitingMs(t({ status: 'resolved' }), NOW)).toBeNull();
		expect(waitingMs(t({ snoozedUntil: NOW + HOUR }), NOW)).toBeNull();
	});

	it('clamps a future timestamp to zero rather than reporting a negative wait', () => {
		expect(waitingMs(t({ lastMessageAt: NOW + HOUR }), NOW)).toBe(0);
	});
});

describe('isWaitingOver24h', () => {
	it('pins the escalation at a day — the web chip mirrors this value', () => {
		expect(WAITING_OVER_24H_MS).toBe(24 * 60 * 60 * 1000);
	});

	it('is inclusive at the boundary and false just under it', () => {
		expect(isWaitingOver24h(t({ lastMessageAt: NOW - WAITING_OVER_24H_MS }), NOW)).toBe(true);
		expect(isWaitingOver24h(t({ lastMessageAt: NOW - WAITING_OVER_24H_MS + 1 }), NOW)).toBe(false);
	});

	it('never fires for a thread that is not waiting on us', () => {
		expect(isWaitingOver24h(t({ status: 'waiting', lastMessageAt: 0 }), NOW)).toBe(false);
	});
});

describe('compareOldestWaiting', () => {
	it('puts the longest-waiting customer first', () => {
		const rows = [
			t({ lastMessageAt: NOW - HOUR }),
			t({ lastMessageAt: NOW - 50 * HOUR }),
			t({ lastMessageAt: NOW - 5 * HOUR }),
		];
		const sorted = [...rows].sort((a, b) => compareOldestWaiting(a, b, NOW));
		expect(sorted.map((r) => NOW - r.lastMessageAt)).toEqual([50 * HOUR, 5 * HOUR, HOUR]);
	});

	it('sinks every thread that is not waiting on us below every one that is', () => {
		const resolvedAncient = t({ status: 'resolved', lastMessageAt: 0 });
		const openRecent = t({ lastMessageAt: NOW - 60_000 });
		const sorted = [resolvedAncient, openRecent].sort((a, b) => compareOldestWaiting(a, b, NOW));
		expect(sorted).toEqual([openRecent, resolvedAncient]);
	});

	it('falls back to oldest activity between two non-waiting threads', () => {
		const a = t({ status: 'resolved', lastMessageAt: 1_000 });
		const b = t({ status: 'closed', lastMessageAt: 9_000 });
		expect(compareOldestWaiting(a, b, NOW)).toBeLessThan(0);
	});

	it('is a stable total order (sorting is idempotent)', () => {
		const rows = [
			t({ lastMessageAt: NOW - 2 * HOUR }),
			t({ status: 'waiting', lastMessageAt: NOW - 9 * HOUR }),
			t({ lastMessageAt: NOW - 30 * HOUR }),
			t({ status: 'resolved', lastMessageAt: NOW - HOUR }),
		];
		const once = [...rows].sort((a, b) => compareOldestWaiting(a, b, NOW));
		const twice = [...once].sort((a, b) => compareOldestWaiting(a, b, NOW));
		expect(twice).toEqual(once);
	});
});
