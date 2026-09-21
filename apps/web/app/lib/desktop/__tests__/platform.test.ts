/**
 * The one platform read, pinned.
 *
 * Three modules used to narrow the platform their own way, two of them off the
 * deprecated `navigator.platform`. These cases are the ones that made those
 * spellings disagree on real machines: an Apple Silicon Mac reporting
 * `MacIntel`, a Chromium webview that freezes `navigator.platform` but still
 * answers `userAgentData.platform`, and iPadOS claiming to be a Macintosh.
 */
import { describe, expect, it } from 'vitest';
import { PLATFORM_ROOT_CLASS, detectDesktopPlatform } from '../platform';

describe('detectDesktopPlatform', () => {
	it('prefers userAgentData, the value browsers still maintain', () => {
		expect(
			detectDesktopPlatform({
				userAgentDataPlatform: 'Windows',
				// A frozen/reduced user agent that says otherwise must not win.
				userAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
			})
		).toBe('windows');
		expect(detectDesktopPlatform({ userAgentDataPlatform: 'macOS' })).toBe('mac');
		expect(detectDesktopPlatform({ userAgentDataPlatform: 'Linux' })).toBe('linux');
	});

	it('falls back to the user agent when userAgentData is absent or blank', () => {
		expect(
			detectDesktopPlatform({
				userAgentDataPlatform: '  ',
				userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
			})
		).toBe('mac');
		expect(detectDesktopPlatform({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })).toBe(
			'windows'
		);
		expect(detectDesktopPlatform({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' })).toBe('linux');
	});

	it('answers mac for every Apple platform — the modifier key is the same', () => {
		expect(detectDesktopPlatform({ userAgentDataPlatform: 'iOS' })).toBe('mac');
		expect(detectDesktopPlatform({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)' })).toBe(
			'mac'
		);
		expect(detectDesktopPlatform({ userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0)' })).toBe('mac');
	});

	it('falls back to linux for anything unrecognised, and for nothing at all', () => {
		// Better instructions than a deep link that fails silently.
		expect(detectDesktopPlatform({})).toBe('linux');
		expect(detectDesktopPlatform({ userAgent: 'Mozilla/5.0 (FreeBSD amd64)' })).toBe('linux');
	});

	it('names an <html> class for every platform it can return', () => {
		expect(Object.keys(PLATFORM_ROOT_CLASS).sort()).toEqual(['linux', 'mac', 'windows']);
	});
});
