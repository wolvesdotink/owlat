/**
 * Unit tests for `ownsGlobalSwitcher` — the presence guard that decides whether
 * the header `GlobalSearch` reacts to the OS-global `owlat:quick-switcher` event
 * (and the in-webview Cmd+K keydown).
 *
 * The OS-level shortcut (tray summon / another app focused) is bridged by
 * `useDesktopShortcuts` into a window `owlat:quick-switcher` event. A mounted
 * `PostboxCommandPalette` owns that event and signals its presence by bumping a
 * shared mount counter, so `GlobalSearch` defers iff that counter is positive —
 * i.e. exactly when a palette is actually listening, not by route path. (The
 * old path-based guard silenced GlobalSearch on the ~14 Postbox routes that
 * render no palette, opening nothing there.)
 */

import { describe, it, expect } from 'vitest';
import { ownsGlobalSwitcher } from '../globalSwitcher';

describe('ownsGlobalSwitcher — global quick-switcher presence guard', () => {
	it('owns the switcher when no Postbox palette is mounted', () => {
		expect(ownsGlobalSwitcher(0)).toBe(true);
	});

	it('defers to PostboxCommandPalette when one is mounted', () => {
		expect(ownsGlobalSwitcher(1)).toBe(false);
	});

	it('keeps deferring while any palette remains mounted', () => {
		// Defensive: overlapping mount/unmount could transiently exceed 1.
		expect(ownsGlobalSwitcher(2)).toBe(false);
	});
});
