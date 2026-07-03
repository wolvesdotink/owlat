/**
 * Unit tests for `parseReleaseTag` — the guard that keeps the in-app update
 * checker from acting on target-only release tags.
 *
 * The repo publishes three release lines: the unified `v*` line plus
 * target-only `server-v*` and `desktop-v*` lines. Only the unified line is
 * marked `--latest`, so `/releases/latest` normally returns a bare `vX.Y.Z`
 * tag. This guard ensures a stray `server-v*` / `desktop-v*` tag is IGNORED
 * (returns null) rather than mis-parsed to 0.0.0 and hiding a real update.
 */

import { describe, it, expect } from 'vitest';
import { parseReleaseTag } from '../systemUpdates';

describe('parseReleaseTag', () => {
	it('parses a bare unified release tag to its semver', () => {
		expect(parseReleaseTag('v0.2.1')).toBe('0.2.1');
		expect(parseReleaseTag('v1.10.0')).toBe('1.10.0');
	});

	it('parses a bare pre-release tag', () => {
		expect(parseReleaseTag('v0.2.1-beta.1')).toBe('0.2.1-beta.1');
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
