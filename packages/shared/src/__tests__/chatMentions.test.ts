import { describe, expect, it } from 'vitest';
import { isMentionHandlePrefix, parseMentionHandles, splitMentionSegments } from '../chatMentions';

describe('parseMentionHandles', () => {
	it('returns handles without the leading @', () => {
		expect(parseMentionHandles('hi @alice and @bob.smith, ping @ops-team_2')).toEqual([
			'alice',
			'bob.smith',
			'ops-team_2',
		]);
	});

	it('lowercases and de-duplicates', () => {
		expect(parseMentionHandles('@Alice @alice @ALICE @bob')).toEqual(['alice', 'bob']);
	});

	it('returns nothing for text without mentions or a bare @', () => {
		expect(parseMentionHandles('no mentions here')).toEqual([]);
		expect(parseMentionHandles('just an @ sign')).toEqual([]);
	});

	it('stops a handle at a character outside the grammar', () => {
		expect(parseMentionHandles('@alice! @bob? @carol/x')).toEqual(['alice', 'bob', 'carol']);
	});

	it('caps a handle at 64 characters', () => {
		const long = 'a'.repeat(70);
		expect(parseMentionHandles(`@${long}`)).toEqual(['a'.repeat(64)]);
		expect(parseMentionHandles(`@${'b'.repeat(64)}`)).toEqual(['b'.repeat(64)]);
	});

	it('gives the same answer on repeated calls (no shared regex state)', () => {
		expect(parseMentionHandles('@alice')).toEqual(['alice']);
		expect(parseMentionHandles('@alice')).toEqual(['alice']);
	});
});

describe('splitMentionSegments', () => {
	it('splits text and mentions in order, keeping the @', () => {
		expect(splitMentionSegments('hey @alice, meet @Bob.')).toEqual([
			{ kind: 'text', value: 'hey ' },
			{ kind: 'mention', value: '@alice' },
			{ kind: 'text', value: ', meet ' },
			{ kind: 'mention', value: '@Bob.' },
		]);
	});

	it('handles a leading mention and a trailing text run', () => {
		expect(splitMentionSegments('@alice hi')).toEqual([
			{ kind: 'mention', value: '@alice' },
			{ kind: 'text', value: ' hi' },
		]);
	});

	it('returns one text segment when there are no mentions, and none for empty text', () => {
		expect(splitMentionSegments('plain')).toEqual([{ kind: 'text', value: 'plain' }]);
		expect(splitMentionSegments('')).toEqual([]);
	});

	it('highlights only the first 64 handle characters', () => {
		expect(splitMentionSegments(`@${'a'.repeat(65)}`)).toEqual([
			{ kind: 'mention', value: `@${'a'.repeat(64)}` },
			{ kind: 'text', value: 'a' },
		]);
	});
});

describe('isMentionHandlePrefix', () => {
	it('accepts the empty fragment right after an @', () => {
		expect(isMentionHandlePrefix('')).toBe(true);
	});

	it('accepts fragments made of handle characters', () => {
		expect(isMentionHandlePrefix('al')).toBe(true);
		expect(isMentionHandlePrefix('bob.smith-2_x')).toBe(true);
	});

	it('rejects fragments with a character outside the grammar', () => {
		expect(isMentionHandlePrefix('al ice')).toBe(false);
		expect(isMentionHandlePrefix('alice!')).toBe(false);
	});

	it('accepts 64 characters and rejects 65', () => {
		expect(isMentionHandlePrefix('a'.repeat(64))).toBe(true);
		expect(isMentionHandlePrefix('a'.repeat(65))).toBe(false);
	});
});
