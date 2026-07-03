import { describe, it, expect } from 'vitest';
import {
	detectShortcodeTrigger,
	fuzzyFilterEmoji,
	matchAsciiSmiley,
	ASCII_SMILEYS,
} from '../postboxEmojiShortcodes';

/** Mirror the composable's caret-span replacement in pure string form. */
function replaceRange(text: string, start: number, end: number, insert: string): string {
	return text.slice(0, start) + insert + text.slice(end);
}

describe('detectShortcodeTrigger', () => {
	it('matches a colon followed by >=2 shortcode chars at the caret', () => {
		const t = detectShortcodeTrigger('hello :sm');
		expect(t).toEqual({ query: 'sm', start: 6 });
	});

	it('lowercases the query', () => {
		expect(detectShortcodeTrigger(':SMi')?.query).toBe('smi');
	});

	it('requires at least two characters after the colon', () => {
		expect(detectShortcodeTrigger('hi :s')).toBeNull();
		expect(detectShortcodeTrigger('hi :')).toBeNull();
	});

	it('triggers at the very start of the text', () => {
		expect(detectShortcodeTrigger(':joy')).toEqual({ query: 'joy', start: 0 });
	});

	it('does NOT trigger inside a URL scheme like http://', () => {
		// The colon in `http:` is preceded by a word char, so it is not a trigger;
		// and the chars after it (`//`) are not shortcode chars either.
		expect(detectShortcodeTrigger('see http://example')).toBeNull();
		expect(detectShortcodeTrigger('http:')).toBeNull();
	});

	it('does NOT trigger for a colon glued to the end of a word', () => {
		expect(detectShortcodeTrigger('note:xy')).toBeNull();
		expect(detectShortcodeTrigger('12:30')).toBeNull();
	});

	it('stops the query at a space (only the tail after the colon matters)', () => {
		expect(detectShortcodeTrigger('a :sm b')).toBeNull();
	});
});

describe('fuzzyFilterEmoji', () => {
	it('ranks an exact shortcode match first', () => {
		const hits = fuzzyFilterEmoji('joy');
		expect(hits[0]?.shortcode).toBe('joy');
		expect(hits[0]?.char).toBe('😂');
	});

	it('surfaces prefix matches for a short query', () => {
		const shortcodes = fuzzyFilterEmoji('smi').map((e) => e.shortcode);
		expect(shortcodes).toContain('smile');
		expect(shortcodes).toContain('smiley');
	});

	it('matches on descriptive name words too', () => {
		const chars = fuzzyFilterEmoji('thumbsup').map((e) => e.char);
		expect(chars).toContain('👍');
	});

	it('caps the result count', () => {
		expect(fuzzyFilterEmoji('a', 5).length).toBeLessThanOrEqual(5);
	});

	it('tolerates a leading colon on the query', () => {
		expect(fuzzyFilterEmoji(':joy')[0]?.shortcode).toBe('joy');
	});

	it('returns nothing for an empty query', () => {
		expect(fuzzyFilterEmoji('')).toEqual([]);
	});
});

describe('insertion replaces the trigger (via detect + replaceRange)', () => {
	it('swaps the whole `:query` span for the emoji char', () => {
		const text = 'hey :joy';
		const trigger = detectShortcodeTrigger(text)!;
		const triggerLen = 1 + trigger.query.length;
		const out = replaceRange(text, trigger.start, trigger.start + triggerLen, '😂');
		expect(out).toBe('hey 😂');
	});

	it('leaves surrounding text intact', () => {
		const text = 'a :smile z'.slice(0, 8); // caret after `:smile` -> "a :smile"
		const trigger = detectShortcodeTrigger(text)!;
		const out = replaceRange(text, trigger.start, text.length, '😄');
		expect(out).toBe('a 😄');
	});
});

describe('matchAsciiSmiley', () => {
	it('maps well-known smileys to emoji', () => {
		expect(matchAsciiSmiley('ok :)')?.char).toBe('🙂');
		expect(matchAsciiSmiley(':(')?.char).toBe('🙁');
		expect(matchAsciiSmiley('haha :D')?.char).toBe('😀');
		expect(matchAsciiSmiley('wink ;)')?.char).toBe('😉');
		expect(matchAsciiSmiley('love <3')?.char).toBe('❤️');
	});

	it('prefers the longer nose variant', () => {
		expect(matchAsciiSmiley(':-)')?.ascii).toBe(':-)');
	});

	it('reports the start index of the smiley', () => {
		const m = matchAsciiSmiley('ok :)');
		expect(m?.start).toBe(3);
	});

	it('only converts at a word boundary (not glued to a word)', () => {
		expect(matchAsciiSmiley('http:)')).toBeNull();
		expect(matchAsciiSmiley('a:)')).toBeNull();
	});

	it('keeps the mapping set small (~8 well-known smileys)', () => {
		expect(ASCII_SMILEYS.length).toBeLessThanOrEqual(12);
	});
});

describe('ASCII conversion is a single reversible step', () => {
	it('replacing the smiley then restoring it round-trips the literal', () => {
		const typed = 'ok :)';
		const match = matchAsciiSmiley(typed)!;
		// Convert: smiley -> emoji + the space the user just pressed.
		const converted = replaceRange(typed, match.start, typed.length, `${match.char} `);
		expect(converted).toBe('ok 🙂 ');
		// One undo restores the literal smiley + space (the recorded restore text).
		const restored = replaceRange(
			converted,
			converted.length - (match.char.length + 1),
			converted.length,
			`${match.ascii} `,
		);
		expect(restored).toBe('ok :) ');
	});
});
