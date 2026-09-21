/**
 * The route → sidebar-width mapping (lib/sidebarFocusArea.ts).
 *
 * The whole point of a focus area is that a Postbox route defaults to the icon
 * rail WITHOUT touching the global collapse preference, so the two states that
 * used to be one are pinned here: a pin inside Postbox must not expand the
 * sidebar on the dashboard, and collapsing the dashboard sidebar must not
 * un-pin Postbox.
 */
import { describe, expect, it } from 'vitest';
import {
	focusAreaForPath,
	isFocusAreaPinned,
	resolveSidebarCollapsed,
	toggleFocusAreaPin,
} from '../sidebarFocusArea';

describe('focusAreaForPath', () => {
	it.each([
		'/dashboard/postbox',
		'/dashboard/postbox/inbox',
		'/dashboard/postbox/migrate',
		'/dashboard/postbox/label/abc123',
	])('claims %s for Postbox', (path) => {
		expect(focusAreaForPath(path)).toBe('postbox');
	});

	it('ignores query and hash', () => {
		expect(focusAreaForPath('/dashboard/postbox/search?q=from:ines')).toBe('postbox');
		expect(focusAreaForPath('/dashboard/postbox/inbox#thread')).toBe('postbox');
	});

	it.each(['/dashboard', '/dashboard/inbox', '/dashboard/knowledge', '/dashboard/postboxes'])(
		'leaves %s alone',
		(path) => {
			expect(focusAreaForPath(path)).toBeNull();
		}
	);
});

describe('resolveSidebarCollapsed', () => {
	it('passes the persisted preference through outside a focus area', () => {
		expect(resolveSidebarCollapsed(false, null, {})).toBe(false);
		expect(resolveSidebarCollapsed(true, null, {})).toBe(true);
		// Even a pin cannot reach outside its own area.
		expect(resolveSidebarCollapsed(true, null, { postbox: true })).toBe(true);
	});

	it('collapses to the icon rail inside an unpinned focus area', () => {
		expect(resolveSidebarCollapsed(false, 'postbox', {})).toBe(true);
		expect(resolveSidebarCollapsed(false, 'postbox', { postbox: false })).toBe(true);
	});

	it('expands inside a pinned focus area, whatever the global preference says', () => {
		expect(resolveSidebarCollapsed(true, 'postbox', { postbox: true })).toBe(false);
		expect(resolveSidebarCollapsed(false, 'postbox', { postbox: true })).toBe(false);
	});
});

describe('pins', () => {
	it('reads an absent or non-boolean entry as unpinned', () => {
		expect(isFocusAreaPinned({}, 'postbox')).toBe(false);
		expect(isFocusAreaPinned({ postbox: undefined }, 'postbox')).toBe(false);
		expect(isFocusAreaPinned({ postbox: true }, null)).toBe(false);
	});

	it('toggles one area without disturbing the map', () => {
		const first = toggleFocusAreaPin({}, 'postbox');
		expect(first).toEqual({ postbox: true });
		expect(toggleFocusAreaPin(first, 'postbox')).toEqual({ postbox: false });
	});
});
