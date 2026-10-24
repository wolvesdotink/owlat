import { describe, it, expect } from 'vitest';
import {
	activePin,
	DEFAULT_DESKTOP_UPDATE_POLICY,
	DESKTOP_RELEASE_CACHE_LIMIT,
	DESKTOP_RELEASE_PAGE_LIMIT,
	newestRelease,
	oneRowPerVersion,
	releasesToPrune,
	resolveDesktopUpdate,
	retainedStableVersions,
	stableReleaseSearch,
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

	it('orders release candidates numerically, so rc.10 is offered over rc.9', () => {
		const releases = [
			release('0.5.0-rc.9', { isPrerelease: true }),
			release('0.5.0-rc.10', { isPrerelease: true }),
		];
		const fromStable = resolve({ channel: 'prerelease' }, releases, '0.4.7');
		expect(fromStable.kind === 'update' && fromStable.release.version).toBe('0.5.0-rc.10');
		const fromRc9 = resolve({ channel: 'prerelease' }, releases, '0.5.0-rc.9');
		expect(fromRc9.kind === 'update' && fromRc9.release.version).toBe('0.5.0-rc.10');
	});
});

describe('cached rows sharing a version', () => {
	const desktop = { version: '0.4.7', line: 'desktop' as const, fetchedAt: 2 };
	const unified = { version: '0.4.7', line: 'unified' as const, fetchedAt: 1 };

	it('keeps one row per version and prefers the unified line whatever the order', () => {
		expect(oneRowPerVersion([desktop, unified])).toEqual([unified]);
		expect(oneRowPerVersion([unified, desktop])).toEqual([unified]);
	});

	it('breaks a same-line tie by the most recent fetch', () => {
		const older = { ...desktop, fetchedAt: 1 };
		const newer = { ...desktop, fetchedAt: 5 };
		expect(oneRowPerVersion([newer, older])).toEqual([newer]);
		expect(oneRowPerVersion([older, newer])).toEqual([newer]);
	});

	it('finds the newest release on a channel by semver', () => {
		const rows = [
			{ version: '0.9.0', isPrerelease: false },
			{ version: '0.10.0', isPrerelease: false },
			{ version: '0.11.0-rc.1', isPrerelease: true },
		];
		expect(newestRelease(rows, 'stable')?.version).toBe('0.10.0');
		expect(newestRelease(rows, 'prerelease')?.version).toBe('0.11.0-rc.1');
		expect(newestRelease([], 'stable')).toBeNull();
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

describe('releasesToPrune', () => {
	/** `count` rows, oldest first: 0.1.0 is the oldest, 0.1.<count-1> the newest. */
	function rows(count: number) {
		return Array.from({ length: count }, (_, i) => ({
			version: `0.1.${i}`,
			line: 'unified' as const,
			isPrerelease: false,
			publishedAt: NOW - (count - i) * HOUR,
		}));
	}

	/** `count` candidates of 0.2.0, all newer than every row `rows` makes. */
	function candidates(count: number) {
		return Array.from({ length: count }, (_, i) => ({
			version: `0.2.0-rc.${i + 1}`,
			line: 'unified' as const,
			isPrerelease: true,
			publishedAt: NOW - (count - i) * 60_000,
		}));
	}

	const latest: DesktopUpdatePolicy = { mode: 'latest', channel: 'stable' };
	const pinnedTo = (version: string): DesktopUpdatePolicy => ({
		mode: 'pinned',
		channel: 'stable',
		pinnedVersion: version,
	});
	const prune = <R extends { version?: string; publishedAt?: number }>(
		cache: R[],
		policy: DesktopUpdatePolicy = latest
	) => releasesToPrune(cache, policy, NOW);

	it('keeps everything while the cache is within its limit', () => {
		expect(prune(rows(DESKTOP_RELEASE_CACHE_LIMIT))).toEqual([]);
	});

	it('drops the oldest rows past the limit when nothing is pinned', () => {
		const doomed = prune(rows(DESKTOP_RELEASE_CACHE_LIMIT + 3));
		expect(doomed.map((row) => row.version).sort()).toEqual(['0.1.0', '0.1.1', '0.1.2']);
	});

	it('keeps the pinned version on top of the newest rows', () => {
		const doomed = prune(rows(DESKTOP_RELEASE_CACHE_LIMIT + 3), pinnedTo('0.1.0'));
		expect(doomed.map((row) => row.version).sort()).toEqual(['0.1.1', '0.1.2']);
	});

	it('keeps both release lines of a pinned version', () => {
		const cache = [
			...rows(DESKTOP_RELEASE_CACHE_LIMIT + 1),
			{
				version: '0.1.0',
				line: 'desktop' as const,
				isPrerelease: false,
				publishedAt: NOW - 1000 * HOUR,
			},
		];
		expect(prune(cache, pinnedTo('0.1.0'))).toEqual([]);
	});

	it('does not grow the cache when the pin is already among the newest', () => {
		const pin = `0.1.${DESKTOP_RELEASE_CACHE_LIMIT + 2}`;
		const doomed = prune(rows(DESKTOP_RELEASE_CACHE_LIMIT + 3), pinnedTo(pin));
		expect(doomed.map((row) => row.version).sort()).toEqual(['0.1.0', '0.1.1', '0.1.2']);
	});

	it('keeps the newest stable release when candidates fill the rolling cache', () => {
		const cache = [...rows(3), ...candidates(DESKTOP_RELEASE_CACHE_LIMIT)];
		const doomed = prune(cache);
		expect(doomed.map((row) => row.version).sort()).toEqual(['0.1.0', '0.1.1']);
		// What a stable client is then served is the kept stable release.
		const left = cache.filter((row) => !doomed.includes(row));
		expect(resolve({}, left, '0.1.1')).toMatchObject({ release: { version: '0.1.2' } });
	});

	it('also keeps the newest stable release past the defer window', () => {
		// 0.1.2 is an hour old: inside a two-hour defer window, so clients are
		// served 0.1.1 until it passes, and 0.1.1 has to survive the candidates.
		const cache = [...rows(3), ...candidates(DESKTOP_RELEASE_CACHE_LIMIT)];
		const deferred: DesktopUpdatePolicy = { ...latest, deferHours: 2 };
		const doomed = prune(cache, deferred);
		expect(doomed.map((row) => row.version)).toEqual(['0.1.0']);
		const left = cache.filter((row) => !doomed.includes(row));
		expect(resolve({ deferHours: 2 }, left, '0.1.0')).toMatchObject({
			release: { version: '0.1.1' },
		});
	});

	it('lets a retained stable release age out once a newer one lands', () => {
		const cache = [
			...rows(2),
			...candidates(DESKTOP_RELEASE_CACHE_LIMIT - 1),
			{ version: '0.2.0', line: 'unified' as const, isPrerelease: false, publishedAt: NOW },
		];
		const doomed = prune(cache);
		expect(doomed.map((row) => row.version).sort()).toEqual(['0.1.0', '0.1.1']);
	});
});

describe('retainedStableVersions', () => {
	it('is the newest stable version when nothing is deferred, ignoring candidates', () => {
		const cache = [
			release('0.4.6', { ageHours: 3 }),
			release('0.4.7', { ageHours: 2 }),
			release('0.5.0-rc.1', { isPrerelease: true, ageHours: 1 }),
		];
		expect([...retainedStableVersions(cache, undefined, NOW)]).toEqual(['0.4.7']);
	});

	it('adds the newest stable version a deferred client is served', () => {
		const cache = [release('0.4.6', { ageHours: 3 }), release('0.4.7', { ageHours: 1 })];
		expect([...retainedStableVersions(cache, 2, NOW)].sort()).toEqual(['0.4.6', '0.4.7']);
	});

	it('is empty when only candidates are cached', () => {
		const cache = [release('0.5.0-rc.1', { isPrerelease: true, ageHours: 1 })];
		expect(retainedStableVersions(cache, undefined, NOW).size).toBe(0);
	});
});

describe('stableReleaseSearch', () => {
	const candidate = { isPrerelease: true, publishedAt: NOW - HOUR };
	const stable = { isPrerelease: false, publishedAt: NOW - HOUR };
	const fresh = { isPrerelease: false, publishedAt: NOW - 1000 };

	it('takes the whole first page and stops once it holds a stable release', () => {
		const search = stableReleaseSearch(undefined, NOW);
		expect(search.wants(1, candidate)).toBe(true);
		search.held(candidate);
		expect(search.readsOn(1, DESKTOP_RELEASE_CACHE_LIMIT)).toBe(true);
		search.held(stable);
		expect(search.readsOn(1, DESKTOP_RELEASE_CACHE_LIMIT)).toBe(false);
	});

	it('wants only stable releases past the first page', () => {
		const search = stableReleaseSearch(undefined, NOW);
		expect(search.wants(2, candidate)).toBe(false);
		expect(search.wants(2, stable)).toBe(true);
		search.held(stable);
		expect(search.wants(2, stable)).toBe(false);
	});

	it('looks on for one past the defer window when the newest stable is deferred', () => {
		const search = stableReleaseSearch(2, NOW);
		search.held(fresh);
		expect(search.readsOn(1, DESKTOP_RELEASE_CACHE_LIMIT)).toBe(true);
		expect(search.wants(2, fresh)).toBe(false);
		expect(search.wants(2, { isPrerelease: false, publishedAt: NOW - 3 * HOUR })).toBe(true);
	});

	it('stops at the end of the history and at the page budget', () => {
		const search = stableReleaseSearch(undefined, NOW);
		expect(search.readsOn(1, DESKTOP_RELEASE_CACHE_LIMIT - 1)).toBe(false);
		expect(search.readsOn(DESKTOP_RELEASE_PAGE_LIMIT - 1, DESKTOP_RELEASE_CACHE_LIMIT)).toBe(true);
		expect(search.readsOn(DESKTOP_RELEASE_PAGE_LIMIT, DESKTOP_RELEASE_CACHE_LIMIT)).toBe(false);
	});
});

describe('activePin', () => {
	it('is the pinned version only while the policy is pinned', () => {
		expect(activePin({ mode: 'pinned', channel: 'stable', pinnedVersion: '0.4.6' })).toBe('0.4.6');
		expect(
			activePin({ mode: 'latest', channel: 'stable', pinnedVersion: '0.4.6' })
		).toBeUndefined();
		expect(
			activePin({ mode: 'paused', channel: 'stable', pinnedVersion: '0.4.6' })
		).toBeUndefined();
	});
});
