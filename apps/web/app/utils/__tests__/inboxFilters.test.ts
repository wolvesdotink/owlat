import { describe, it, expect } from 'vitest';
import {
	INBOX_FILTERS,
	INBOX_FILTER_COUNT_KEY,
	INBOX_FILTER_META,
	INBOX_SORTS,
	DEFAULT_INBOX_FILTER,
	DEFAULT_INBOX_SORT,
	nextInboxSort,
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
		expect(inboxFilterToQuery('unassigned')).toBe('unassigned');
	});

	it('falls back to the default for absent or unknown values', () => {
		expect(parseInboxFilter(undefined)).toBe(DEFAULT_INBOX_FILTER);
		expect(parseInboxFilter(null)).toBe(DEFAULT_INBOX_FILTER);
		expect(parseInboxFilter('bogus')).toBe(DEFAULT_INBOX_FILTER);
		expect(parseInboxFilter('')).toBe(DEFAULT_INBOX_FILTER);
	});

	it('accepts a repeated query key by taking the first value', () => {
		expect(parseInboxFilter(['waiting', 'mine'])).toBe('waiting');
		expect(parseInboxFilter(['nope', 'mine'] as string[])).toBe(DEFAULT_INBOX_FILTER);
	});

	it('parses each known slug verbatim', () => {
		const slugs: InboxFilter[] = [
			'open',
			'mine',
			'unassigned',
			'waiting',
			'waiting-24h',
			'snoozed',
			'resolved',
		];
		for (const slug of slugs) {
			expect(parseInboxFilter(slug)).toBe(slug);
		}
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

	it('maps every pill to a count field, with the escalation pill renamed', () => {
		for (const filter of INBOX_FILTERS) {
			expect(INBOX_FILTER_COUNT_KEY[filter], filter).toBeTruthy();
		}
		// The slug carries a hyphen; a Convex object field cannot.
		expect(INBOX_FILTER_COUNT_KEY['waiting-24h']).toBe('waitingOver24h');
		expect(INBOX_FILTER_COUNT_KEY.open).toBe('open');
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
