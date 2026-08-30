/**
 * Team Inbox thread text search (inbox/threadSearch + the pill predicate it
 * leans on).
 *
 * Two rules are pinned here:
 *   1. `threadMatchesFilter` says exactly what `buildThreadQuery`'s index says.
 *      The search path cannot select an index, so if these two ever disagree a
 *      pill's list and that pill's search disagree — the same class of bug the
 *      shared `buildThreadQuery` was introduced to prevent between the list and
 *      its counts.
 *   2. `mergeThreadSearchHits` dedupes the two indexes, applies the pill, and
 *      returns a recency-ordered top-N.
 *
 * Deliberately unit tests, not `convexTest` ones: `withSearchIndex` is not
 * implemented by the test runtime (see contactsOrganization.integration.test),
 * so everything that can be wrong lives in these two pure functions and the
 * reading around them is three lines.
 */
import { describe, it, expect } from 'vitest';
import type { Doc, Id } from '../../_generated/dataModel';
import { threadMatchesFilter, type ThreadFilter } from '../threadFilters';
import {
	THREAD_SEARCH_MIN_QUERY,
	THREAD_SEARCH_SCAN_CAP,
	mergeThreadSearchHits,
} from '../threadSearch';
import { WAITING_OVER_24H_MS } from '../threadSort';

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;
const ME = 'user_me';

let seq = 0;
function thread(overrides: Partial<Doc<'conversationThreads'>> = {}): Doc<'conversationThreads'> {
	seq += 1;
	return {
		_id: `t${seq}` as Id<'conversationThreads'>,
		_creationTime: NOW - HOUR,
		subject: 'Renewal quote',
		normalizedSubject: 'renewal quote',
		contactIdentifier: 'ana@acme.test',
		status: 'open',
		messageCount: 1,
		lastMessageAt: NOW - HOUR,
		firstMessageAt: NOW - HOUR,
		createdAt: NOW - HOUR,
		...overrides,
	} as Doc<'conversationThreads'>;
}

const matches = (row: Doc<'conversationThreads'>, filter: ThreadFilter | undefined) =>
	threadMatchesFilter(row, filter, ME, NOW);

describe('threadMatchesFilter', () => {
	it('admits every thread when no pill is active', () => {
		expect(matches(thread({ status: 'closed' }), undefined)).toBe(true);
		expect(matches(thread({ snoozedUntil: NOW + HOUR }), undefined)).toBe(true);
	});

	it('open: active conversations, snoozed ones parked under Snoozed only', () => {
		expect(matches(thread({ status: 'open' }), 'open')).toBe(true);
		expect(matches(thread({ status: 'waiting' }), 'open')).toBe(false);
		expect(matches(thread({ status: 'open', snoozedUntil: NOW + HOUR }), 'open')).toBe(false);
		// A lapsed snooze is awake again — same as the index-side `lte(now)`.
		expect(matches(thread({ status: 'open', snoozedUntil: NOW - HOUR }), 'open')).toBe(true);
	});

	it('waiting: waiting on the CUSTOMER, not on us', () => {
		expect(matches(thread({ status: 'waiting' }), 'waiting')).toBe(true);
		expect(matches(thread({ status: 'open' }), 'waiting')).toBe(false);
	});

	it('waiting-24h: open, past the escalation, inclusive at the boundary', () => {
		const atBoundary = thread({ lastMessageAt: NOW - WAITING_OVER_24H_MS });
		const justUnder = thread({ lastMessageAt: NOW - WAITING_OVER_24H_MS + 1 });
		expect(matches(atBoundary, 'waiting-24h')).toBe(true);
		expect(matches(justUnder, 'waiting-24h')).toBe(false);
		// The escalation is about work waiting on US, so a `waiting` row is out.
		expect(
			matches(
				thread({ status: 'waiting', lastMessageAt: NOW - 2 * WAITING_OVER_24H_MS }),
				'waiting-24h'
			)
		).toBe(false);
	});

	it('mine: assigned to the viewer and still active', () => {
		expect(matches(thread({ assignedTo: ME }), 'mine')).toBe(true);
		expect(matches(thread({ assignedTo: 'someone_else' }), 'mine')).toBe(false);
		expect(matches(thread({ assignedTo: ME, status: 'resolved' }), 'mine')).toBe(false);
		expect(matches(thread({ assignedTo: ME, status: 'waiting' }), 'mine')).toBe(true);
		expect(matches(thread({ assignedTo: ME, snoozedUntil: NOW + HOUR }), 'mine')).toBe(false);
	});

	it('unassigned: nobody owns it and it is still active', () => {
		expect(matches(thread({ assignedTo: undefined }), 'unassigned')).toBe(true);
		expect(matches(thread({ assignedTo: ME }), 'unassigned')).toBe(false);
		expect(matches(thread({ status: 'closed' }), 'unassigned')).toBe(false);
	});

	it('snoozed: only a snooze that has not lapsed', () => {
		expect(matches(thread({ snoozedUntil: NOW + HOUR }), 'snoozed')).toBe(true);
		expect(matches(thread({ snoozedUntil: NOW - HOUR }), 'snoozed')).toBe(false);
		expect(matches(thread(), 'snoozed')).toBe(false);
	});

	it('resolved: finished work, snoozed or not', () => {
		expect(matches(thread({ status: 'resolved' }), 'resolved')).toBe(true);
		expect(matches(thread({ status: 'resolved', snoozedUntil: NOW + HOUR }), 'resolved')).toBe(
			true
		);
		expect(matches(thread({ status: 'closed' }), 'resolved')).toBe(false);
	});
});

describe('mergeThreadSearchHits', () => {
	const merge = (
		bySubject: Doc<'conversationThreads'>[],
		byParticipant: Doc<'conversationThreads'>[],
		overrides: { filter?: ThreadFilter; limit?: number } = {}
	) =>
		mergeThreadSearchHits(bySubject, byParticipant, {
			userId: ME,
			now: NOW,
			limit: overrides.limit ?? 20,
			filter: overrides.filter,
		});

	it('returns a thread that matched BOTH indexes exactly once', () => {
		const both = thread({ subject: 'Acme renewal', contactIdentifier: 'ana@acme.test' });
		expect(merge([both], [both]).map((row) => row._id)).toEqual([both._id]);
	});

	it('unions the two indexes — a participant-only match is a hit', () => {
		const subjectHit = thread({ subject: 'Acme renewal', lastMessageAt: NOW - 2 * HOUR });
		const participantHit = thread({ subject: 'Invoice 42', contactIdentifier: 'bo@acme.test' });
		const merged = merge([subjectHit], [participantHit]);
		expect(merged).toHaveLength(2);
		expect(merged.map((row) => row._id)).toContain(participantHit._id);
	});

	it('orders survivors newest activity first, regardless of which index found them', () => {
		const oldest = thread({ lastMessageAt: NOW - 5 * HOUR });
		const newest = thread({ lastMessageAt: NOW - HOUR });
		const middle = thread({ lastMessageAt: NOW - 3 * HOUR });
		expect(merge([oldest, middle], [newest]).map((row) => row.lastMessageAt)).toEqual([
			NOW - HOUR,
			NOW - 3 * HOUR,
			NOW - 5 * HOUR,
		]);
	});

	it('narrows the union by the active pill', () => {
		const mine = thread({ assignedTo: ME });
		const theirs = thread({ assignedTo: 'someone_else' });
		expect(merge([mine, theirs], [], { filter: 'mine' }).map((row) => row._id)).toEqual([mine._id]);
	});

	it('caps at the requested limit, keeping the most recent', () => {
		const rows = [
			thread({ lastMessageAt: NOW - HOUR }),
			thread({ lastMessageAt: NOW - 2 * HOUR }),
			thread({ lastMessageAt: NOW - 3 * HOUR }),
		];
		expect(merge(rows, [], { limit: 2 }).map((row) => row.lastMessageAt)).toEqual([
			NOW - HOUR,
			NOW - 2 * HOUR,
		]);
		expect(merge(rows, [], { limit: 0 })).toEqual([]);
	});

	it('is a total order — equal activity still sorts deterministically', () => {
		const a = thread({ _id: 'aaa' as Id<'conversationThreads'>, lastMessageAt: NOW });
		const b = thread({ _id: 'bbb' as Id<'conversationThreads'>, lastMessageAt: NOW });
		expect(merge([b, a], []).map((row) => row._id)).toEqual(['aaa', 'bbb']);
		expect(merge([a, b], []).map((row) => row._id)).toEqual(['aaa', 'bbb']);
	});
});

describe('search bounds', () => {
	it('reads a capped window per index, so a broad query cannot sweep the table', () => {
		expect(THREAD_SEARCH_SCAN_CAP).toBeGreaterThan(0);
		expect(THREAD_SEARCH_SCAN_CAP).toBeLessThanOrEqual(256);
	});

	it('needs more than a single character before it searches', () => {
		expect(THREAD_SEARCH_MIN_QUERY).toBeGreaterThanOrEqual(2);
	});
});
