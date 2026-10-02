import { describe, it, expect } from 'vitest';
import {
	detectSnippetTrigger,
	rankSnippets,
	firstNameOf,
	lastNameOf,
	threadSubjectOf,
} from '../postboxSnippets';

describe('detectSnippetTrigger', () => {
	it('triggers on a "/" at the very start of the input', () => {
		expect(detectSnippetTrigger('/th')).toEqual({ query: 'th', triggerStart: 0 });
	});

	it('triggers on a "/" after whitespace (new word)', () => {
		expect(detectSnippetTrigger('hello /gr')).toEqual({
			query: 'gr',
			triggerStart: 6,
		});
	});

	it('does NOT trigger mid-word (slash preceded by a letter)', () => {
		expect(detectSnippetTrigger('foo/bar')).toBeNull();
		expect(detectSnippetTrigger('http://x')).toBeNull();
	});

	it('does NOT trigger once whitespace follows the slash (token closed)', () => {
		expect(detectSnippetTrigger('/th ')).toBeNull();
		expect(detectSnippetTrigger('/one two')).toBeNull();
	});

	it('returns null when there is no slash', () => {
		expect(detectSnippetTrigger('just text')).toBeNull();
	});

	it('triggers on ";", the documented key, the same way', () => {
		expect(detectSnippetTrigger(';ref')).toEqual({ query: 'ref', triggerStart: 0 });
		expect(detectSnippetTrigger('Hello\n;re')).toEqual({ query: 're', triggerStart: 6 });
		expect(detectSnippetTrigger('a;b')).toBeNull();
		expect(detectSnippetTrigger('; ')).toBeNull();
	});

	it('reads the query up to the caret (last slash wins)', () => {
		expect(detectSnippetTrigger('a /x b /yz')).toEqual({
			query: 'yz',
			triggerStart: 7,
		});
	});
});

describe('rankSnippets', () => {
	const snippets = [
		{ name: 'Thanks', shortcut: 'ty' },
		{ name: 'Thanks a lot', shortcut: 'tyvm' },
		{ name: 'Greeting', shortcut: 'hi' },
	];

	it('returns all snippets for an empty query', () => {
		expect(rankSnippets(snippets, '')).toHaveLength(3);
	});

	it('ranks an exact shortcut match first', () => {
		const ranked = rankSnippets(snippets, 'ty');
		expect(ranked[0]).toEqual({ name: 'Thanks', shortcut: 'ty' });
	});

	it('ranks shortcut prefix above name matches', () => {
		const ranked = rankSnippets(snippets, 'tyv');
		expect(ranked[0]).toEqual({ name: 'Thanks a lot', shortcut: 'tyvm' });
	});

	it('matches on name substring', () => {
		const ranked = rankSnippets(snippets, 'greet');
		expect(ranked).toHaveLength(1);
		expect(ranked[0]?.name).toBe('Greeting');
	});

	it('drops non-matching snippets', () => {
		expect(rankSnippets(snippets, 'zzz')).toHaveLength(0);
	});

	it('matches fuzzily, as a subsequence', () => {
		expect(rankSnippets(snippets, 'grtg').map((s) => s.name)).toEqual(['Greeting']);
	});

	it('lists the most used first before anything is typed, then the most recent', () => {
		const used = [
			{ name: 'Alpha', shortcut: 'a', useCount: 1, lastUsedAt: 5 },
			{ name: 'Beta', shortcut: 'b', useCount: 4, lastUsedAt: 1 },
			{ name: 'Gamma', shortcut: 'g', useCount: 1, lastUsedAt: 9 },
			{ name: 'Delta', shortcut: 'd' },
		];
		expect(rankSnippets(used, '').map((s) => s.name)).toEqual(['Beta', 'Gamma', 'Alpha', 'Delta']);
	});

	it('breaks ties between equal matches by usage', () => {
		const used = [
			{ name: 'Refund A', shortcut: '', useCount: 0 },
			{ name: 'Refund B', shortcut: '', useCount: 7 },
		];
		expect(rankSnippets(used, 'refund').map((s) => s.name)).toEqual(['Refund B', 'Refund A']);
	});
});

describe('lastNameOf', () => {
	it('takes everything after the first name', () => {
		expect(lastNameOf('Ada King Lovelace')).toBe('King Lovelace');
		expect(lastNameOf('Ada')).toBeUndefined();
		expect(lastNameOf(null)).toBeUndefined();
	});
});

describe('threadSubjectOf', () => {
	it('drops reply and forward markers, in several languages', () => {
		expect(threadSubjectOf('Re: Re: Invoice 4471')).toBe('Invoice 4471');
		expect(threadSubjectOf('AW: WG: Angebot')).toBe('Angebot');
		expect(threadSubjectOf('Fwd: Re[2]: Plan')).toBe('Plan');
		expect(threadSubjectOf('Regarding the plan')).toBe('Regarding the plan');
		expect(threadSubjectOf(undefined)).toBe('');
	});
});

describe('firstNameOf', () => {
	it('takes the first whitespace-delimited token', () => {
		expect(firstNameOf('Ada Lovelace')).toBe('Ada');
	});

	it('returns undefined for empty / missing names', () => {
		expect(firstNameOf('')).toBeUndefined();
		expect(firstNameOf(null)).toBeUndefined();
		expect(firstNameOf(undefined)).toBeUndefined();
		expect(firstNameOf('   ')).toBeUndefined();
	});
});
