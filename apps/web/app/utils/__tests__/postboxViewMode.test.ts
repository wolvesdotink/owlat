/**
 * Postbox inbox view-mode derivations:
 *   - resolvePostboxViewMode normalises stored/unknown values to a valid mode
 *     (defaulting to 'flat'), and
 *   - postboxListRenderer maps mode + folder to the list renderer — grouped
 *     renderers are inbox-only, every other folder always renders flat.
 */
import { describe, it, expect } from 'vitest';
import {
	POSTBOX_VIEW_MODE_DEFAULT,
	POSTBOX_VIEW_MODE_OPTIONS,
	postboxListRenderer,
	resolvePostboxViewMode,
} from '../postboxViewMode';

describe('resolvePostboxViewMode', () => {
	it('defaults to flat for unset values', () => {
		expect(resolvePostboxViewMode(undefined)).toBe('flat');
		expect(resolvePostboxViewMode(null)).toBe('flat');
		expect(POSTBOX_VIEW_MODE_DEFAULT).toBe('flat');
	});

	it('passes through every valid mode', () => {
		expect(resolvePostboxViewMode('flat')).toBe('flat');
		expect(resolvePostboxViewMode('conversations')).toBe('conversations');
		expect(resolvePostboxViewMode('categories')).toBe('categories');
		expect(resolvePostboxViewMode('bundled')).toBe('bundled');
		expect(resolvePostboxViewMode('sections')).toBe('sections');
	});

	it('normalises an unknown stored value to flat', () => {
		expect(resolvePostboxViewMode('stacked')).toBe('flat');
	});
});

describe('POSTBOX_VIEW_MODE_OPTIONS', () => {
	it('offers exactly the five modes, flat first', () => {
		expect(POSTBOX_VIEW_MODE_OPTIONS.map((o) => o.value)).toEqual([
			'flat',
			'conversations',
			'categories',
			'bundled',
			'sections',
		]);
	});

	it('labels segments in human language', () => {
		expect(POSTBOX_VIEW_MODE_OPTIONS.map((o) => o.label)).toEqual([
			'Flat',
			'Conversations',
			'Categories',
			'Bundled',
			'Sections',
		]);
	});
});

describe('postboxListRenderer', () => {
	it('maps each mode to its renderer in the inbox', () => {
		expect(postboxListRenderer('flat', 'inbox')).toBe('flat');
		expect(postboxListRenderer('conversations', 'inbox')).toBe('conversations');
		expect(postboxListRenderer('categories', 'inbox')).toBe('categories');
		expect(postboxListRenderer('bundled', 'inbox')).toBe('bundled');
		expect(postboxListRenderer('sections', 'inbox')).toBe('sections');
	});

	it('keeps every non-inbox folder flat regardless of mode', () => {
		for (const folder of ['archive', 'sent', 'trash', 'spam', 'snoozed']) {
			expect(postboxListRenderer('conversations', folder)).toBe('flat');
			expect(postboxListRenderer('categories', folder)).toBe('flat');
			expect(postboxListRenderer('bundled', folder)).toBe('flat');
			expect(postboxListRenderer('sections', folder)).toBe('flat');
		}
	});
});
