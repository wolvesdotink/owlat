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
	describeChips,
	parseSearchSize,
} from '../postboxSearchQuery';

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

describe('parseSearchSize', () => {
	it('reads the size shorthands, defaulting to bytes', () => {
		expect(parseSearchSize('1024')).toBe(1024);
		expect(parseSearchSize('5k')).toBe(5 * 1024);
		expect(parseSearchSize('5KB')).toBe(5 * 1024);
		expect(parseSearchSize('2.5M')).toBe(Math.round(2.5 * 1024 * 1024));
		expect(parseSearchSize('1g')).toBe(1024 * 1024 * 1024);
	});

	it('rejects a unit it does not know rather than guessing', () => {
		expect(parseSearchSize('5tb')).toBeNull();
		expect(parseSearchSize('big')).toBeNull();
	});
});

describe('parseSearchQuery — filter-grammar parity', () => {
	it('reads cc: and bcc: as their own operands', () => {
		const parsed = parseSearchQuery('cc:Legal bcc:archive@acme.com');
		expect(parsed.cc).toBe('legal');
		expect(parsed.bcc).toBe('archive@acme.com');
		expect(parsed.text).toBe('');
	});

	it('reads larger:/smaller: into byte bounds', () => {
		const parsed = parseSearchQuery('larger:5M smaller:20M');
		expect(parsed.largerThan).toBe(5 * 1024 * 1024);
		expect(parsed.smallerThan).toBe(20 * 1024 * 1024);
	});

	it('leaves an unparseable size in the free text instead of dropping it', () => {
		const parsed = parseSearchQuery('larger:huge');
		expect(parsed.largerThan).toBeUndefined();
		expect(parsed.text).toBe('larger:huge');
	});

	it('reads filename: as an attachment-name operand', () => {
		const parsed = parseSearchQuery('filename:Invoice.pdf');
		expect(parsed.filename).toBe('invoice.pdf');
	});
});

describe('parseSearchQuery — negation', () => {
	it('collects a negated substring operator under `not`', () => {
		const parsed = parseSearchQuery('-from:ines');
		expect(parsed.from).toBeUndefined();
		expect(parsed.not).toEqual({ from: ['ines'] });
	});

	it('keeps several exclusions of the same operator', () => {
		// The positive `from:` is last-wins; exclusions are a conjunction, so
		// both have to survive or the second silently widens the search.
		const parsed = parseSearchQuery('-from:ines -from:mei');
		expect(parsed.not?.from).toEqual(['ines', 'mei']);
	});

	it('negates free text and a quoted phrase', () => {
		const parsed = parseSearchQuery('invoice -draft -"final version"');
		expect(parsed.text).toBe('invoice');
		expect(parsed.not?.text).toEqual(['draft', 'final version']);
		expect(parsed.phrases).toBeUndefined();
	});

	it('flips the boolean operators rather than collecting them', () => {
		expect(parseSearchQuery('-is:unread').flagSeen).toBe(true);
		expect(parseSearchQuery('-is:read').flagSeen).toBe(false);
		expect(parseSearchQuery('-is:starred').flagFlagged).toBe(false);
		expect(parseSearchQuery('-has:attachment').hasAttachment).toBe(false);
		expect(parseSearchQuery('-has:no-attachment').hasAttachment).toBe(true);
	});

	it('negates label: and in: by name', () => {
		const parsed = parseSearchQuery('-label:noise -in:spam');
		expect(parsed.labelName).toBeUndefined();
		expect(parsed.not?.labelName).toEqual(['noise']);
		expect(parsed.not?.folderRole).toEqual(['spam']);
	});

	it('ignores a minus on the date operators instead of shifting the boundary', () => {
		// "not before X" and "after X" differ at the boundary; reading the minus
		// as the opposite operator would quietly return a different day's mail.
		const parsed = parseSearchQuery('-before:2024-01-01');
		expect(parsed.beforeMs).toBe(Date.parse('2024-01-01'));
	});

	it('treats a bare minus as ordinary text', () => {
		expect(parseSearchQuery('-').text).toBe('-');
	});
});

describe('parseSearchQuery — single-level OR', () => {
	it('splits top-level alternatives into clauses', () => {
		const parsed = parseSearchQuery('from:ines OR from:mei');
		expect(parsed.from).toBe('ines');
		expect(parsed.or).toEqual([{ text: '', from: 'mei' }]);
	});

	it('keeps each side of the OR a full conjunction', () => {
		const parsed = parseSearchQuery('from:ines is:unread OR label:billing invoice');
		expect(parsed).toMatchObject({ from: 'ines', flagSeen: false, text: '' });
		expect(parsed.or).toEqual([{ text: 'invoice', labelName: 'billing' }]);
	});

	it('drops an empty alternative so a half-typed OR cannot match everything', () => {
		const parsed = parseSearchQuery('from:ines OR');
		expect(parsed.or).toBeUndefined();
		expect(parsed.from).toBe('ines');
	});

	it('only reads an unquoted uppercase OR as the keyword', () => {
		expect(parseSearchQuery('cats or dogs').or).toBeUndefined();
		expect(parseSearchQuery('cats or dogs').text).toBe('cats or dogs');
		expect(parseSearchQuery('"OR"').or).toBeUndefined();
	});

	it('leaves a query with no OR shaped exactly as before', () => {
		expect(parseSearchQuery('from:sara hello')).toEqual({ text: 'hello', from: 'sara' });
	});
});

describe('removeSearchOperator — negation and OR', () => {
	it('removes only the sign the chip carries', () => {
		// The `-from: noise` chip must not take `from: ines` with it.
		expect(removeSearchOperator('from:ines -from:noise', '-from')).toBe('from:ines');
		expect(removeSearchOperator('from:ines -from:noise', 'from')).toBe('-from:noise');
	});

	it('preserves the sign and the quoting of what it keeps', () => {
		expect(removeSearchOperator('to:a -subject:"q r"', 'to')).toBe('-subject:"q r"');
	});

	it('drops the OR left dangling by a removal', () => {
		expect(removeSearchOperator('from:ines OR from:mei', 'from')).toBe('');
		expect(removeSearchOperator('from:ines OR label:billing', 'from')).toBe('label:billing');
	});
});

describe('stripSearchOperators — negation and OR', () => {
	it('drops negated operators along with the positive ones', () => {
		expect(stripSearchOperators('-from:ines label:x hello')).toBe('hello');
	});

	it('does not leave a dangling OR behind', () => {
		expect(stripSearchOperators('from:a OR from:b hello')).toBe('hello');
	});
});

describe('describeChips', () => {
	it('renders the new operators, negation and both OR sides', () => {
		const chips = describeChips(parseSearchQuery('cc:legal larger:5M -from:ines OR label:billing'));
		expect(chips).toEqual([
			{ key: 'cc', label: 'cc: legal' },
			{ key: 'larger', label: 'larger: 5M' },
			{ key: '-from', label: '-from: ines' },
			{ key: 'label', label: 'label: billing' },
		]);
	});

	it('deduplicates a chip that both OR sides produce', () => {
		const chips = describeChips(parseSearchQuery('is:unread from:a OR is:unread from:b'));
		expect(chips.filter((c) => c.key === 'is')).toHaveLength(1);
	});
});
