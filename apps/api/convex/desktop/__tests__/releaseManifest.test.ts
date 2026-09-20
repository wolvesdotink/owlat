import { describe, it, expect } from 'vitest';
import { isValidManifest, parseDesktopReleaseTag } from '../releaseManifest';

/**
 * The two cache-time trust decisions. `parseDesktopReleaseTag` decides which
 * release lines can carry a desktop bundle; `isValidManifest` decides what may
 * be stored and later served byte-for-byte to an updater running as the user.
 */

function manifest(over: Record<string, unknown> = {}): string {
	return JSON.stringify({
		version: '0.4.6',
		platforms: {
			'linux-x86_64': {
				url: 'https://github.com/wolvesdotink/owlat/releases/download/v0.4.6/owlat.AppImage',
				signature: 'dW50cnVzdGVkIGNvbW1lbnQ=',
			},
		},
		...over,
	});
}

describe('parseDesktopReleaseTag', () => {
	it('accepts both desktop-bearing lines and reports which one', () => {
		expect(parseDesktopReleaseTag('v0.4.6')).toEqual({ version: '0.4.6', line: 'unified' });
		expect(parseDesktopReleaseTag('desktop-v0.4.7')).toEqual({
			version: '0.4.7',
			line: 'desktop',
		});
		expect(parseDesktopReleaseTag('v0.5.0-rc.1')).toEqual({
			version: '0.5.0-rc.1',
			line: 'unified',
		});
	});

	it('rejects the server line and anything that is not a release tag', () => {
		for (const tag of ['server-v0.4.6', 'nightly', 'v0.4', '0.4.6', 'v0.4.6/../x', '']) {
			expect(parseDesktopReleaseTag(tag)).toBeNull();
		}
	});
});

describe('isValidManifest', () => {
	it('accepts a well-formed manifest whose version matches its tag', () => {
		expect(isValidManifest(manifest(), '0.4.6')).toBe(true);
		expect(isValidManifest(manifest({ version: 'v0.4.6' }), '0.4.6')).toBe(true);
	});

	it('accepts the other GitHub asset hosts', () => {
		for (const host of ['api.github.com', 'objects.githubusercontent.com']) {
			const body = manifest({
				platforms: { 'linux-x86_64': { url: `https://${host}/a.AppImage`, signature: 's' } },
			});
			expect(isValidManifest(body, '0.4.6')).toBe(true);
		}
	});

	it('rejects a version mismatch, so a tag can never advertise someone else’s build', () => {
		expect(isValidManifest(manifest({ version: '9.9.9' }), '0.4.6')).toBe(false);
	});

	it('rejects a bundle URL pointing anywhere but GitHub', () => {
		const body = manifest({
			platforms: {
				'linux-x86_64': { url: 'https://evil.example.com/owlat.AppImage', signature: 's' },
				'darwin-universal': {
					url: 'https://github.com/wolvesdotink/owlat/releases/download/v0.4.6/owlat.dmg',
					signature: 's',
				},
			},
		});
		expect(isValidManifest(body, '0.4.6')).toBe(false);
	});

	it('rejects a platform with no signature, an empty platform map and junk', () => {
		expect(
			isValidManifest(
				manifest({ platforms: { 'linux-x86_64': { url: 'https://github.com/a' } } }),
				'0.4.6'
			)
		).toBe(false);
		expect(isValidManifest(manifest({ platforms: {} }), '0.4.6')).toBe(false);
		expect(isValidManifest(manifest({ platforms: [] }), '0.4.6')).toBe(false);
		expect(isValidManifest('not json', '0.4.6')).toBe(false);
		expect(isValidManifest('null', '0.4.6')).toBe(false);
	});
});
