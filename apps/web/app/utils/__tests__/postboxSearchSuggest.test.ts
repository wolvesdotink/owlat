/**
 * Search-bar autocomplete — the token under the caret, the rows offered for
 * it, and the history list.
 *
 * The bar's whole promise is that the operator grammar becomes discoverable by
 * typing, so the cases that matter are the ones where a naive whitespace split
 * or a naive prefix match would offer the wrong thing: a caret inside a quoted
 * operand, a negated term, and an operand list that has to stay quoted.
 */
import { describe, it, expect } from 'vitest';

import {
	MAX_RECENT_POSTBOX_SEARCHES,
	activeSearchToken,
	applySearchSuggestion,
	buildSearchSuggestions,
	pushRecentSearch,
} from '../postboxSearchSuggest';

const contacts = [
	{ email: 'ines@northwind.studio', displayName: 'Ines Weber' },
	{ email: 'mei@tanaka.jp', displayName: 'Mei Tanaka' },
];
const labels = [{ name: 'Billing' }, { name: 'Big Client' }];

describe('activeSearchToken', () => {
	it('takes the token the caret sits in', () => {
		const token = activeSearchToken('from:ines is:unread', 8);
		expect(token).toEqual({ start: 0, end: 9, text: 'from:ines' });
	});

	it('keeps a quoted operand whole instead of tearing off its tail', () => {
		// A whitespace split would hand back `re` and offer operator completions
		// while the user is halfway through typing a subject.
		const value = 'subject:"quarterly re';
		const token = activeSearchToken(value, value.length);
		expect(token.text).toBe('subject:"quarterly re');
	});

	it('reads an empty trailing token after a space', () => {
		const token = activeSearchToken('from:ines ', 10);
		expect(token).toEqual({ start: 10, end: 10, text: '' });
	});
});

describe('applySearchSuggestion', () => {
	it('replaces only the active token and reports the new caret', () => {
		const value = 'fr is:unread';
		const next = applySearchSuggestion(value, activeSearchToken(value, 2), 'from:');
		expect(next.value).toBe('from: is:unread');
		expect(next.caret).toBe(5);
	});
});

describe('buildSearchSuggestions', () => {
	it('completes an operator from a bare prefix', () => {
		const rows = buildSearchSuggestions({ token: 'fr' });
		expect(rows[0]?.insert).toBe('from:');
		expect(rows[0]?.kind).toBe('operator');
		expect(rows[0]?.isTerminal).toBe(false);
	});

	it('carries a leading minus through the completion', () => {
		const rows = buildSearchSuggestions({ token: '-fr' });
		expect(rows[0]?.insert).toBe('-from:');
	});

	it('offers the address book for the address operators', () => {
		const rows = buildSearchSuggestions({ token: 'from:in', contacts });
		expect(rows.map((r) => r.insert)).toEqual(['from:ines@northwind.studio']);
		// A display name is the user's own data, not catalog prose.
		expect(rows[0]?.detail).toBe('Ines Weber');
		expect(rows[0]?.hint).toBeUndefined();
	});

	it('matches a contact on the display name as well as the address', () => {
		const rows = buildSearchSuggestions({ token: 'to:tanaka', contacts });
		expect(rows.map((r) => r.insert)).toEqual(['to:mei@tanaka.jp']);
	});

	it('quotes a label whose name carries a space', () => {
		// Unquoted, `label:Big Client` would tokenize into an operator plus a
		// stray free-text word and quietly search for the wrong thing.
		const rows = buildSearchSuggestions({ token: 'label:big', labels });
		expect(rows.map((r) => r.insert)).toEqual(['label:"Big Client"']);
	});

	it('offers the system folder roles for in:', () => {
		const rows = buildSearchSuggestions({ token: 'in:s' });
		expect(rows.map((r) => r.insert)).toEqual(['in:sent', 'in:spam', 'in:snoozed']);
	});

	it('offers the closed value set for is:', () => {
		const rows = buildSearchSuggestions({ token: 'is:' });
		expect(rows.map((r) => r.insert)).toEqual(['is:unread', 'is:read', 'is:starred']);
		expect(rows.every((r) => r.isTerminal)).toBe(true);
	});

	it('offers nothing for a free-form operand', () => {
		expect(buildSearchSuggestions({ token: 'subject:quarterly' })).toEqual([]);
		expect(buildSearchSuggestions({ token: 'larger:5' })).toEqual([]);
	});

	it('offers history, and only history, for an empty box', () => {
		const rows = buildSearchSuggestions({ token: '', recents: ['is:unread has:attachment'] });
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ kind: 'recent', insert: 'is:unread has:attachment' });
	});

	it('ranks history below the grammar it is still completing', () => {
		const rows = buildSearchSuggestions({ token: 'is', recents: ['is:unread from:ines'] });
		expect(rows[0]?.kind).toBe('operator');
		expect(rows.at(-1)?.kind).toBe('recent');
	});

	it('honours the limit', () => {
		expect(buildSearchSuggestions({ token: 'f', limit: 2 })).toHaveLength(2);
	});

	it('carries every hint as an i18n key, never as prose', () => {
		for (const row of buildSearchSuggestions({ token: 'a' })) {
			if (row.hint) expect(row.hint.key).toMatch(/^components\.postbox\./);
		}
	});
});

describe('pushRecentSearch', () => {
	it('puts the newest first and de-duplicates', () => {
		const list = pushRecentSearch(pushRecentSearch(['b'], 'a'), 'b');
		expect(list).toEqual(['b', 'a']);
	});

	it('ignores a blank query', () => {
		expect(pushRecentSearch(['a'], '   ')).toEqual(['a']);
	});

	it('caps the history', () => {
		let list: string[] = [];
		for (let i = 0; i < MAX_RECENT_POSTBOX_SEARCHES + 5; i++)
			list = pushRecentSearch(list, `q${i}`);
		expect(list).toHaveLength(MAX_RECENT_POSTBOX_SEARCHES);
	});
});
