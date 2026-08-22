/**
 * parseSearchQuery / tokenizeSearchQuery — the search box's grammar.
 *
 * The tokenizer previously split on whitespace unconditionally, so any operand
 * containing a space silently broke apart: `subject:"quarterly report"` became
 * an operator whose value was `"quarterly` plus a stray `report"` dumped into
 * the free text. These pin quoting for both operator values and bare phrases,
 * and the operator-removal helpers the chips use.
 */
import { describe, it, expect } from 'vitest';

import {
	parseSearchQuery,
	tokenizeSearchQuery,
	removeSearchOperator,
	stripSearchOperators,
} from '../usePostboxSearch';

describe('tokenizeSearchQuery', () => {
	it('splits on whitespace outside quotes', () => {
		expect(tokenizeSearchQuery('a b  c').map((t) => t.raw)).toEqual(['a', 'b', 'c']);
	});

	it('keeps a quoted run as one token and drops the quotes', () => {
		const tokens = tokenizeSearchQuery('subject:"quarterly report" from:sara');
		expect(tokens.map((t) => t.raw)).toEqual(['subject:quarterly report', 'from:sara']);
		expect(tokens[0]!.quoted).toBe(true);
		expect(tokens[1]!.quoted).toBe(false);
	});

	it('runs an unclosed quote to the end rather than dropping it', () => {
		// Mid-typing: the user has opened a quote and not yet closed it.
		expect(tokenizeSearchQuery('subject:"quarterly rep').map((t) => t.raw)).toEqual([
			'subject:quarterly rep',
		]);
	});

	it('treats an empty quoted string as a token, not as nothing', () => {
		expect(tokenizeSearchQuery('""').map((t) => t.raw)).toEqual(['']);
	});
});

describe('parseSearchQuery', () => {
	it('reads a quoted operator value as a single operand', () => {
		const parsed = parseSearchQuery('subject:"quarterly report"');
		expect(parsed.subject).toBe('quarterly report');
		expect(parsed.text).toBe('');
	});

	it('keeps unquoted operators working alongside quoted ones', () => {
		const parsed = parseSearchQuery('from:sara subject:"quarterly report" is:unread hello');
		expect(parsed.from).toBe('sara');
		expect(parsed.subject).toBe('quarterly report');
		expect(parsed.flagSeen).toBe(false);
		expect(parsed.text).toBe('hello');
	});

	it('records a bare quoted run as a phrase AND leaves its words in text', () => {
		// The words stay in `text` so the backend's search index still does the
		// indexed narrowing; `phrases` adds the adjacency requirement on top.
		const parsed = parseSearchQuery('"exact phrase" hello');
		expect(parsed.phrases).toEqual(['exact phrase']);
		expect(parsed.text).toBe('exact phrase hello');
	});

	it('does not read a colon inside a quoted phrase as an operator', () => {
		const parsed = parseSearchQuery('"10:30 standup"');
		expect(parsed.phrases).toEqual(['10:30 standup']);
		expect(parsed.folderRole).toBeUndefined();
		expect(parsed.text).toBe('10:30 standup');
	});

	it('does not set phrases for a single quoted word', () => {
		// One word cannot have an adjacency constraint — the index already does it.
		const parsed = parseSearchQuery('"standup"');
		expect(parsed.phrases).toBeUndefined();
		expect(parsed.text).toBe('standup');
	});
});

describe('removeSearchOperator', () => {
	it('removes a quoted operator whole, leaving no fragment behind', () => {
		expect(removeSearchOperator('from:sara subject:"quarterly report" hello', 'subject')).toBe(
			'from:sara hello'
		);
	});

	it('removes every occurrence of the operator', () => {
		expect(removeSearchOperator('from:sara from:bob hi', 'from')).toBe('hi');
	});

	it('preserves the quoting of what it keeps', () => {
		expect(removeSearchOperator('from:sara "exact phrase"', 'from')).toBe('"exact phrase"');
	});
});

describe('stripSearchOperators', () => {
	it('drops operators and keeps quoted free text intact', () => {
		expect(stripSearchOperators('from:sara subject:"q r" "exact phrase" hi')).toBe(
			'"exact phrase" hi'
		);
	});
});
