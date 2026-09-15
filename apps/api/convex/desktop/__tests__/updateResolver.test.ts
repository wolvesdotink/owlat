import { describe, it, expect } from 'vitest';
import {
	DEFAULT_DESKTOP_UPDATE_POLICY,
	resolveDesktopUpdate,
	type DesktopUpdatePolicy,
} from '../updateResolver';

/**
 * The whole server-side desktop update decision, exercised as a pure function:
 * both release lines under `latest`, the channel filter, the defer window, the
 * three `pinned` outcomes, `paused`, an unparsable client version, and the
 * equal-version case that keeps a client where it is.
 */

const NOW = Date.parse('2026-09-15T12:00:00Z');
const HOUR = 3600_000;

function release(version: string, options: { isPrerelease?: boolean; ageHours?: number } = {}) {
	return {
		version,
		isPrerelease: options.isPrerelease ?? false,
		publishedAt: NOW - (options.ageHours ?? 48) * HOUR,
	};
}

function resolve(
	policy: Partial<DesktopUpdatePolicy>,
	releases: ReturnType<typeof release>[],
	currentVersion: string
) {
	return resolveDesktopUpdate({
		policy: { ...DEFAULT_DESKTOP_UPDATE_POLICY, ...policy },
		releases,
		currentVersion,
		now: NOW,
	});
}

describe('resolveDesktopUpdate — latest', () => {
	it('offers the newest release across both tag families', () => {
		// 0.4.7 only exists on the desktop-only line — the gap the old GitHub
		// `/releases/latest` endpoint could not see.
		const decision = resolve({}, [release('0.4.6'), release('0.4.7')], '0.4.6');
		expect(decision).toEqual({
			kind: 'update',
			release: expect.objectContaining({ version: '0.4.7' }),
		});
	});

	it('compares by semver, not lexicographically', () => {
		const decision = resolve({}, [release('0.9.0'), release('0.10.0')], '0.8.0');
		expect(decision.kind === 'update' && decision.release.version).toBe('0.10.0');
	});

	it('returns none:current when the client already runs the newest release', () => {
		expect(resolve({}, [release('0.4.6')], '0.4.6')).toEqual({ kind: 'none', reason: 'current' });
	});

	it('never offers a downgrade to a client that is ahead', () => {
		expect(resolve({}, [release('0.4.6')], '0.5.0')).toEqual({ kind: 'none', reason: 'current' });
	});

	it('returns none:noRelease when nothing is cached', () => {
		expect(resolve({}, [], '0.4.6')).toEqual({ kind: 'none', reason: 'noRelease' });
	});
});

describe('resolveDesktopUpdate — channel', () => {
	it('hides pre-releases on the stable channel', () => {
		const releases = [release('0.4.6'), release('0.5.0-rc.1', { isPrerelease: true })];
		expect(resolve({ channel: 'stable' }, releases, '0.4.5')).toEqual({
			kind: 'update',
			release: expect.objectContaining({ version: '0.4.6' }),
		});
	});

	it('admits them on the prerelease channel', () => {
		const releases = [release('0.4.6'), release('0.5.0-rc.1', { isPrerelease: true })];
		const decision = resolve({ channel: 'prerelease' }, releases, '0.4.5');
		expect(decision.kind === 'update' && decision.release.version).toBe('0.5.0-rc.1');
	});
});

describe('resolveDesktopUpdate — defer window', () => {
	it('withholds a release until publishedAt + deferHours has passed', () => {
		const releases = [release('0.4.6', { ageHours: 100 }), release('0.4.7', { ageHours: 2 })];
		expect(resolve({ deferHours: 24 }, releases, '0.4.5')).toEqual({
			kind: 'update',
			release: expect.objectContaining({ version: '0.4.6' }),
		});
	});

	it('offers it once the window has passed', () => {
		const releases = [release('0.4.7', { ageHours: 25 })];
		const decision = resolve({ deferHours: 24 }, releases, '0.4.6');
		expect(decision.kind === 'update' && decision.release.version).toBe('0.4.7');
	});
});

describe('resolveDesktopUpdate — pinned', () => {
	const releases = [release('0.4.5'), release('0.4.6'), release('0.4.7')];

	it('serves exactly the pinned version to a client below it', () => {
		const decision = resolve({ mode: 'pinned', pinnedVersion: '0.4.6' }, releases, '0.4.5');
		expect(decision.kind === 'update' && decision.release.version).toBe('0.4.6');
	});

	it('does not roll a client that is already above the pin backwards', () => {
		expect(resolve({ mode: 'pinned', pinnedVersion: '0.4.6' }, releases, '0.4.7')).toEqual({
			kind: 'none',
			reason: 'current',
		});
	});

	it('returns none:pinMissing when the pinned version is not cached', () => {
		expect(resolve({ mode: 'pinned', pinnedVersion: '9.9.9' }, releases, '0.4.5')).toEqual({
			kind: 'none',
			reason: 'pinMissing',
		});
	});

	it('treats a pin that is invisible on this channel as missing', () => {
		const withRc = [release('0.5.0-rc.1', { isPrerelease: true })];
		expect(resolve({ mode: 'pinned', pinnedVersion: '0.5.0-rc.1' }, withRc, '0.4.6')).toEqual({
			kind: 'none',
			reason: 'pinMissing',
		});
	});
});

describe('resolveDesktopUpdate — stop conditions', () => {
	it('serves nothing at all while paused', () => {
		expect(resolve({ mode: 'paused' }, [release('9.9.9')], '0.4.6')).toEqual({
			kind: 'none',
			reason: 'paused',
		});
	});

	it('serves nothing to a client whose version is not semver', () => {
		for (const current of ['dev', 'unknown', '0.4', '../etc/passwd', '']) {
			expect(resolve({}, [release('9.9.9')], current)).toEqual({
				kind: 'none',
				reason: 'unparsable',
			});
		}
	});

	it('tolerates a leading v on the client version', () => {
		const decision = resolve({}, [release('0.4.7')], 'v0.4.6');
		expect(decision.kind === 'update' && decision.release.version).toBe('0.4.7');
	});

	it('ignores a cached row whose version is malformed', () => {
		expect(resolve({}, [release('not-a-version')], '0.4.6')).toEqual({
			kind: 'none',
			reason: 'noRelease',
		});
	});
});
