import { describe, it, expect } from 'vitest';
import {
	DEFAULT_INBOX_ASSIGNEE,
	INBOX_ASSIGNEES,
	INBOX_ASSIGNEE_META,
	INBOX_FILTERS,
	INBOX_FILTER_META,
	INBOX_SORTS,
	DEFAULT_INBOX_FILTER,
	DEFAULT_INBOX_SORT,
	inboxAssigneeArg,
	inboxAssigneeToQuery,
	legacyInboxSort,
	nextInboxSort,
	parseInboxAssignee,
	parseInboxFilter,
	inboxFilterToQuery,
	resolveInboxSort,
	type InboxFilter,
} from '../inboxFilters';

describe('inbox filter URL state', () => {
	it('round-trips every filter through the query param', () => {
		for (const filter of INBOX_FILTERS) {
			// parse(serialize(f)) === f for all filters (default serializes to
			// undefined, which parses back to the default).
			expect(parseInboxFilter(inboxFilterToQuery(filter))).toBe(filter);
		}
	});

	it('keeps the default view out of the URL', () => {
		expect(inboxFilterToQuery(DEFAULT_INBOX_FILTER)).toBeUndefined();
		expect(inboxFilterToQuery('waiting')).toBe('waiting');
	});

	it('falls back to the default for absent or unknown values', () => {
		expect(parseInboxFilter(undefined)).toBe(DEFAULT_INBOX_FILTER);
		expect(parseInboxFilter(null)).toBe(DEFAULT_INBOX_FILTER);
		expect(parseInboxFilter('bogus')).toBe(DEFAULT_INBOX_FILTER);
		expect(parseInboxFilter('')).toBe(DEFAULT_INBOX_FILTER);
	});

	it('accepts a repeated query key by taking the first value', () => {
		expect(parseInboxFilter(['waiting', 'resolved'])).toBe('waiting');
		expect(parseInboxFilter(['nope', 'waiting'] as string[])).toBe(DEFAULT_INBOX_FILTER);
	});

	it('has exactly four status tabs, with no assignment mixed in', () => {
		const slugs: InboxFilter[] = ['open', 'waiting', 'snoozed', 'resolved'];
		expect([...INBOX_FILTERS]).toEqual(slugs);
		for (const slug of slugs) {
			expect(parseInboxFilter(slug)).toBe(slug);
		}
	});
});

describe('inbox assignment filter', () => {
	it('offers Anyone / Me / Unassigned, defaulting to anyone', () => {
		expect([...INBOX_ASSIGNEES]).toEqual(['anyone', 'me', 'unassigned']);
		expect(DEFAULT_INBOX_ASSIGNEE).toBe('anyone');
		for (const a of INBOX_ASSIGNEES) {
			expect(INBOX_ASSIGNEE_META[a].label).toMatch(/^shared\.inboxAssignees\./);
		}
	});

	it('round-trips through ?assignee= and keeps anyone out of the URL', () => {
		for (const a of INBOX_ASSIGNEES) {
			expect(parseInboxAssignee(inboxAssigneeToQuery(a))).toBe(a);
		}
		expect(inboxAssigneeToQuery('anyone')).toBeUndefined();
		expect(parseInboxAssignee('bogus')).toBe('anyone');
	});

	it('only sends an assignee to the query when one is picked', () => {
		expect(inboxAssigneeArg('anyone')).toBeUndefined();
		expect(inboxAssigneeArg('me')).toBe('me');
		expect(inboxAssigneeArg('unassigned')).toBe('unassigned');
	});

	it('keeps old ?filter= links working: they become Open + an assignee or an order', () => {
		expect(parseInboxFilter('mine')).toBe('open');
		expect(parseInboxAssignee(undefined, 'mine')).toBe('me');
		expect(parseInboxAssignee(undefined, 'unassigned')).toBe('unassigned');
		// An explicit ?assignee= wins over the legacy meaning.
		expect(parseInboxAssignee('anyone', 'mine')).toBe('anyone');
		expect(parseInboxFilter('waiting-24h')).toBe('open');
		expect(legacyInboxSort('waiting-24h')).toBe('oldest-waiting');
		expect(legacyInboxSort('waiting')).toBeUndefined();
	});
});

describe('inbox filter registry', () => {
	it('carries a label and empty-state KEY for every pill', () => {
		for (const filter of INBOX_FILTERS) {
			const meta = INBOX_FILTER_META[filter];
			expect(meta.label, filter).toMatch(/^shared\.inboxFilters\./);
			expect(meta.empty, filter).toMatch(/^shared\.inboxFilters\./);
		}
	});
});

describe('inbox sort cycle', () => {
	it('defaults to needs-attention and normalises anything unknown', () => {
		expect(DEFAULT_INBOX_SORT).toBe('needs-attention');
		// A browser holding a value from before the waiting order existed.
		expect(resolveInboxSort('by-size')).toBe(DEFAULT_INBOX_SORT);
		expect(resolveInboxSort(undefined)).toBe(DEFAULT_INBOX_SORT);
		expect(resolveInboxSort(7)).toBe(DEFAULT_INBOX_SORT);
	});

	it('cycles through every order and wraps', () => {
		let sort = DEFAULT_INBOX_SORT;
		const seen = [sort];
		for (let step = 0; step < INBOX_SORTS.length - 1; step++) {
			sort = nextInboxSort(sort);
			seen.push(sort);
		}
		expect(new Set(seen).size).toBe(INBOX_SORTS.length);
		expect(nextInboxSort(sort)).toBe(DEFAULT_INBOX_SORT);
	});

	it('offers the waiting order, so newest can no longer bury the oldest thread', () => {
		expect(INBOX_SORTS).toContain('oldest-waiting');
	});
});
