import { describe, it, expect } from 'vitest';
import { detectSnippetTrigger, rankSnippets, firstNameOf } from '../postboxSnippets';

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
