/**
 * The one search history, and the two older shapes it has to swallow.
 *
 * Two stores became one: the palette's flat `owlat_recent_searches` array and
 * the Postbox search bar's private `owlat_postbox_recent_searches`. Both hold
 * real user history, so the merge has to be lossless in both directions and
 * survive a hand-edited or truncated value rather than throwing inside an
 * overlay that is already open.
 */
import { describe, expect, it } from 'vitest';
import {
	MAX_RECENTS_PER_SCOPE,
	absorbLegacyMailRecents,
	emptyScopedRecents,
	parseScopedRecents,
	pushScopedRecent,
} from '../commandPaletteRecents';

describe('parseScopedRecents', () => {
	it('reads the scope-tagged shape', () => {
		const parsed = parseScopedRecents(
			JSON.stringify({ mail: ['from:ines'], everything: ['acme'] })
		);
		expect(parsed.mail).toEqual(['from:ines']);
		expect(parsed.everything).toEqual(['acme']);
		expect(parsed.ask).toEqual([]);
	});

	it('reads the pre-scope flat array as object-search history', () => {
		// That list was only ever the cross-object index, so it is `everything`.
		expect(parseScopedRecents(JSON.stringify(['acme', 'globex'])).everything).toEqual([
			'acme',
			'globex',
		]);
	});

	it('reads absent, broken and hand-edited values as empty', () => {
		expect(parseScopedRecents(null)).toEqual(emptyScopedRecents());
		expect(parseScopedRecents('{"mail": [')).toEqual(emptyScopedRecents());
		expect(parseScopedRecents('"a string"')).toEqual(emptyScopedRecents());
		expect(parseScopedRecents(JSON.stringify({ mail: [1, null, 'ok', '  '] })).mail).toEqual([
			'ok',
		]);
	});
});

describe('absorbLegacyMailRecents', () => {
	it('folds the search bar history into Mail, palette entries first', () => {
		const merged = absorbLegacyMailRecents(
			{ ...emptyScopedRecents(), mail: ['is:unread'] },
			JSON.stringify(['from:ines', 'is:unread'])
		);
		// The duplicate keeps its newer position rather than being listed twice.
		expect(merged.mail).toEqual(['is:unread', 'from:ines']);
	});

	it('leaves the store untouched when there is nothing to absorb', () => {
		const recents = emptyScopedRecents();
		expect(absorbLegacyMailRecents(recents, null)).toBe(recents);
		expect(absorbLegacyMailRecents(recents, '[]')).toBe(recents);
		expect(absorbLegacyMailRecents(recents, 'not json')).toBe(recents);
	});
});

describe('pushScopedRecent', () => {
	it('puts the newest first and de-duplicates, per scope', () => {
		let recents = pushScopedRecent(emptyScopedRecents(), 'mail', 'b');
		recents = pushScopedRecent(recents, 'mail', 'a');
		recents = pushScopedRecent(recents, 'mail', 'b');
		expect(recents.mail).toEqual(['b', 'a']);
		expect(recents.everything).toEqual([]);
	});

	it('ignores a blank query', () => {
		const recents = { ...emptyScopedRecents(), mail: ['a'] };
		expect(pushScopedRecent(recents, 'mail', '   ')).toBe(recents);
	});

	it('caps each scope', () => {
		let recents = emptyScopedRecents();
		for (let index = 0; index < MAX_RECENTS_PER_SCOPE + 5; index += 1) {
			recents = pushScopedRecent(recents, 'mail', `q${index}`);
		}
		expect(recents.mail).toHaveLength(MAX_RECENTS_PER_SCOPE);
	});
});
