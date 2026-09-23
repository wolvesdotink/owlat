import { describe, expect, it } from 'vitest';
import { resolveActiveChord } from '../shortcutScope';

/**
 * The Team inbox Updates list moves with the `review` scope (its
 * usePostboxListKeyboard passes `scope: 'review'`). The scope outlived the
 * retired review list, so pin that j / k / Enter still resolve in it.
 */
describe('review scope', () => {
	it('moves and opens rows in the Updates list', () => {
		expect(resolveActiveChord('j', ['review'])).toBe('review.next');
		expect(resolveActiveChord('k', ['review'])).toBe('review.previous');
		expect(resolveActiveChord('Enter', ['review'])).toBe('review.open');
	});
});
