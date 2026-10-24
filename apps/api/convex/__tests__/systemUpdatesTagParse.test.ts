/**
 * Unit tests for `parseReleaseTag` and `offeredReleaseVersion` — the guards
 * that keep the in-app update checker from acting on target-only release tags
 * and on release candidates.
 *
 * The repo publishes three release lines: the unified `v*` line plus
 * target-only `server-v*` and `desktop-v*` lines. Only stable unified releases
 * are marked `--latest`, so `/releases/latest` normally returns a bare `vX.Y.Z`
 * tag. These guards ensure a stray `server-v*` / `desktop-v*` tag or a
 * prerelease is IGNORED (returns null) rather than mis-parsed to 0.0.0 and
 * hiding a real update, or offered to every instance as one.
 */

import { describe, it, expect } from 'vitest';
import { offeredReleaseVersion, parseReleaseTag } from '../systemUpdatesReleaseCheck';

describe('parseReleaseTag', () => {
	it('parses a bare unified release tag to its semver', () => {
		expect(parseReleaseTag('v0.2.1')).toBe('0.2.1');
		expect(parseReleaseTag('v1.10.0')).toBe('1.10.0');
	});

	it('ignores release candidates and other pre-release tags', () => {
		expect(parseReleaseTag('v0.2.1-rc.1')).toBeNull();
		expect(parseReleaseTag('v0.2.1-beta.1')).toBeNull();
	});

	it('ignores target-only server/desktop release tags', () => {
		expect(parseReleaseTag('server-v0.2.1')).toBeNull();
		expect(parseReleaseTag('desktop-v0.2.1')).toBeNull();
		expect(parseReleaseTag('server-v1.0.0-rc.1')).toBeNull();
	});

	it('ignores malformed or empty tags', () => {
		expect(parseReleaseTag('')).toBeNull();
		expect(parseReleaseTag('v0.2')).toBeNull();
		expect(parseReleaseTag('0.2.1')).toBeNull();
		expect(parseReleaseTag('latest')).toBeNull();
	});
});

describe('offeredReleaseVersion', () => {
	it('offers a published stable release', () => {
		expect(offeredReleaseVersion({ tag_name: 'v0.7.0', draft: false, prerelease: false })).toBe(
			'0.7.0'
		);
		expect(offeredReleaseVersion({ tag_name: 'v0.7.0' })).toBe('0.7.0');
	});

	it('never offers a release GitHub flags as a prerelease or draft', () => {
		expect(offeredReleaseVersion({ tag_name: 'v0.7.0', prerelease: true })).toBeNull();
		expect(offeredReleaseVersion({ tag_name: 'v0.7.0', draft: true })).toBeNull();
	});

	it('never offers a release candidate, whatever its flags say', () => {
		expect(
			offeredReleaseVersion({ tag_name: 'v0.7.0-rc.1', draft: false, prerelease: false })
		).toBeNull();
	});
});
