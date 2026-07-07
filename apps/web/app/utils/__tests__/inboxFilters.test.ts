import { describe, it, expect } from 'vitest';
import {
	INBOX_FILTERS,
	DEFAULT_INBOX_FILTER,
	parseInboxFilter,
	inboxFilterToQuery,
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
		const slugs: InboxFilter[] = ['open', 'mine', 'unassigned', 'waiting', 'snoozed', 'resolved'];
		for (const slug of slugs) {
			expect(parseInboxFilter(slug)).toBe(slug);
		}
	});
});
