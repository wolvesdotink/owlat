/**
 * Which desktop release, if any, a connected app is offered.
 *
 * This is the whole decision the server makes about desktop updates, kept pure
 * (no Convex context, no clock, no I/O) so every branch is unit-testable and so
 * `desktop/updates.ts` stays a thin layer of reads around it. The caller passes
 * the instance policy, the cached releases and `now`; it gets back either a
 * release to serve verbatim or a reason for serving nothing.
 *
 * The server chooses among releases GitHub already published and this instance
 * already cached. It cannot mint one: the bundles are signed with a key no
 * server holds, and the client refuses a downgrade. "Withhold, never
 * substitute" is the whole extent of the power modelled here.
 */
import { isValidTargetVersion } from '@owlat/shared/releaseArtifacts';
import { semverCompare } from '@owlat/shared/semver';

export type DesktopUpdateMode = 'latest' | 'pinned' | 'paused';
export type DesktopUpdateChannel = 'stable' | 'prerelease';

/** Upper bound for the defer window, in hours (one week). */
export const MAX_DEFER_HOURS = 168;

/**
 * How many release rows the cache keeps; older ones are pruned on refresh. It is
 * also the page size of the GitHub release listing, so one page is one cache.
 */
export const DESKTOP_RELEASE_CACHE_LIMIT = 30;

/**
 * How many pages of the GitHub release listing a refresh may read while it
 * looks for a stable release: release candidates are published as
 * pre-releases and can fill the newest page on their own.
 */
export const DESKTOP_RELEASE_PAGE_LIMIT = 10;

/**
 * Rows the pinned version may hold on top of that limit: one per release line,
 * since `desktop-v0.4.7` and `v0.4.7` are cached side by side.
 */
export const PINNED_RELEASE_ROW_LIMIT = 2;

/**
 * Stable versions kept outside the rolling cache (see `retainedStableVersions`),
 * and equally the most stable releases a refresh caches from beyond its first
 * page (see `stableReleaseSearch`).
 */
const RETAINED_STABLE_VERSION_LIMIT = 2;

/**
 * Upper bound for a read of the whole cache. The index orders by version
 * STRING, so a read has to cover every row that can exist at once: the rolling
 * cache, a pin and the retained stable versions held outside it (every line of
 * each), and the new rows a refresh has cached but not yet pruned (a full
 * GitHub page plus the stable releases it found past that page).
 */
export const DESKTOP_RELEASE_READ_LIMIT =
	DESKTOP_RELEASE_CACHE_LIMIT * 2 +
	PINNED_RELEASE_ROW_LIMIT * (1 + RETAINED_STABLE_VERSION_LIMIT) +
	RETAINED_STABLE_VERSION_LIMIT;

/** What a fresh instance with no `instanceSettings.desktopUpdates` row behaves as. */
export const DEFAULT_DESKTOP_UPDATE_POLICY: DesktopUpdatePolicy = {
	mode: 'latest',
	channel: 'stable',
};

export interface DesktopUpdatePolicy {
	mode: DesktopUpdateMode;
	channel: DesktopUpdateChannel;
	pinnedVersion?: string;
	requiredVersion?: string;
	deferHours?: number;
}

/** The fields of a cached release the decision needs. */
export interface ResolvableRelease {
	version: string;
	isPrerelease?: boolean;
	publishedAt?: number;
}

/** The fields of a cached row (`desktopReleases`, kind `release`) the cache helpers read. */
export interface CachedReleaseRow {
	version?: string;
	line?: 'unified' | 'desktop';
	isPrerelease?: boolean;
	publishedAt?: number;
	fetchedAt?: number;
}

/**
 * Which of two cached rows carrying the SAME version clients should be served.
 * The cache is keyed by tag, so a desktop hot-fix `desktop-v0.4.7` and a later
 * unified `v0.4.7` both survive a refresh; the unified line wins (it is the line
 * GitHub marks latest and the one `release:cut` produces), and the most recently
 * fetched row breaks any remaining tie.
 */
export function preferCachedRelease<R extends CachedReleaseRow>(candidate: R, current: R): boolean {
	if (candidate.line !== current.line) return candidate.line === 'unified';
	return (candidate.fetchedAt ?? 0) > (current.fetchedAt ?? 0);
}

/**
 * One row per version, chosen by `preferCachedRelease`, so a client asking
 * about 0.4.7 gets the same bundle on every check rather than whichever line
 * the last refresh happened to touch.
 */
export function oneRowPerVersion<R extends CachedReleaseRow>(releases: R[]): R[] {
	const byVersion = new Map<string, R>();
	for (const release of releases) {
		const version = release.version ?? '';
		const current = byVersion.get(version);
		if (!current || preferCachedRelease(release, current)) byVersion.set(version, release);
	}
	return [...byVersion.values()];
}

/** Newest cached release on a channel, by semver. */
export function newestRelease<R extends CachedReleaseRow>(
	releases: R[],
	channel: DesktopUpdateChannel
): R | null {
	return releases
		.filter((release) => !release.isPrerelease || channel === 'prerelease')
		.reduce<R | null>(
			(best, release) =>
				best === null || semverCompare(release.version ?? '', best.version ?? '') > 0
					? release
					: best,
			null
		);
}

/** The version the policy holds the fleet to, or undefined when it is not pinned. */
export function activePin(policy: DesktopUpdatePolicy): string | undefined {
	return policy.mode === 'pinned' ? policy.pinnedVersion : undefined;
}

/**
 * The release a `latest` client on the stable channel is served out of these
 * rows, ignoring its own version: the semver-newest stable release past the
 * defer window. It picks one row per version (`oneRowPerVersion`) BEFORE it
 * applies the window, exactly as `manifestForClient` feeds `resolveDesktopUpdate`:
 * a `desktop-v0.4.7` row past the window does not make 0.4.7 servable while the
 * preferred unified `v0.4.7` is still inside it.
 */
function servedStableRelease<R extends CachedReleaseRow>(
	rows: R[],
	deferHours: number | undefined,
	now: number
): R | null {
	const deferMs = Math.max(0, deferHours ?? 0) * 3600_000;
	return newestRelease(
		oneRowPerVersion(rows).filter(
			(row) => isValidTargetVersion(row.version ?? '') && (row.publishedAt ?? 0) + deferMs <= now
		),
		'stable'
	);
}

/**
 * The stable versions the cache keeps whatever their age: the newest stable
 * release, and the one a `latest` client on the stable channel is actually
 * served (`servedStableRelease`). Release candidates are pre-releases and can
 * outnumber the rolling cache on their own; without this, a run of them would
 * evict every stable release, leaving stable clients nothing to update to and
 * the app no reason to go around the instance.
 */
export function retainedStableVersions<R extends CachedReleaseRow>(
	rows: R[],
	deferHours: number | undefined,
	now: number
): Set<string> {
	const newest = newestRelease(
		oneRowPerVersion(rows).filter((row) => isValidTargetVersion(row.version ?? '')),
		'stable'
	);
	const served = servedStableRelease(rows, deferHours, now);
	const versions = new Set<string>();
	for (const row of [newest, served]) if (row?.version) versions.add(row.version);
	return versions;
}

/**
 * The cached rows a refresh deletes: everything outside the newest
 * `DESKTOP_RELEASE_CACHE_LIMIT` by publication time, except the rows of the
 * pinned version and of the retained stable versions. The pin was validated
 * against the cache when it was saved, and dropping its row would leave the
 * policy pinned to a release no client can be served. The exemptions end with
 * their reason: once the pin moves on or a newer stable release lands, the same
 * rows age out on the next refresh like any other.
 */
export function releasesToPrune<R extends CachedReleaseRow>(
	rows: R[],
	policy: DesktopUpdatePolicy,
	now: number
): R[] {
	if (rows.length <= DESKTOP_RELEASE_CACHE_LIMIT) return [];
	const kept = retainedStableVersions(rows, policy.deferHours, now);
	const pinnedVersion = activePin(policy);
	if (pinnedVersion !== undefined) kept.add(pinnedVersion);
	return [...rows]
		.sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0))
		.slice(DESKTOP_RELEASE_CACHE_LIMIT)
		.filter((row) => !kept.has(row.version ?? ''));
}

/** What a refresh knows about one release on the GitHub listing. */
export interface ListedRelease {
	version: string;
	line: 'unified' | 'desktop';
	isPrerelease: boolean;
	publishedAt: number;
}

/**
 * A refresh's walk down the GitHub release listing, newest first, one page of
 * `DESKTOP_RELEASE_CACHE_LIMIT` at a time. The first page is cached whole: it is
 * the rolling cache. Past it, only what `retainedStableVersions` would keep is
 * wanted: the newest stable release, then the first one that makes the held
 * rows servable by `servedStableRelease`, the rule the resolver and the prune
 * apply, and the walk ends there. Being past the defer window is not enough: a
 * `desktop-v0.4.7` row adds nothing while the preferred unified `v0.4.7` is
 * held, since that row decides whether 0.4.7 is served. Any other stable row
 * past the window is its version's preferred row, so at most two rows are
 * cached past the first page. Candidates past it would be pruned on arrival.
 * The page budget bounds the walk when no stable release exists.
 */
export function stableReleaseSearch(deferHours: number | undefined, now: number) {
	const deferMs = Math.max(0, deferHours ?? 0) * 3600_000;
	const heldStable: ListedRelease[] = [];
	let servedHeld = false;
	const unifiedHeld = (version: string) =>
		heldStable.some((row) => row.version === version && row.line === 'unified');
	return {
		/** Whether a listed release is worth caching, or counting when already cached. */
		wants(page: number, release: ListedRelease): boolean {
			if (page === 1) return true;
			if (servedHeld || release.isPrerelease) return false;
			if (heldStable.length === 0) return true;
			return release.publishedAt + deferMs <= now && !unifiedHeld(release.version);
		},
		/** Record a listed release the cache now holds. */
		held(release: ListedRelease): void {
			if (release.isPrerelease) return;
			heldStable.push(release);
			servedHeld = servedStableRelease(heldStable, deferHours, now) !== null;
		},
		/** Whether to read the next page, after reading `page` with `listed` entries. */
		readsOn(page: number, listed: number): boolean {
			return (
				!servedHeld && listed >= DESKTOP_RELEASE_CACHE_LIMIT && page < DESKTOP_RELEASE_PAGE_LIMIT
			);
		},
	};
}

/**
 * Why nothing is being offered. Reported to the admin surface and logged; the
 * wire answer for every one of these is the same 204.
 */
export type DesktopUpdateNoneReason =
	| 'unparsable' // the client sent a version that is not semver (e.g. 'dev')
	| 'paused' // the operator stopped the rollout
	| 'pinMissing' // mode is pinned but the pinned version is not cached
	| 'noRelease' // nothing cached is eligible on this channel yet
	| 'current'; // the client is already at or above the target

export type DesktopUpdateDecision<R extends ResolvableRelease> =
	| { kind: 'none'; reason: DesktopUpdateNoneReason }
	| { kind: 'update'; release: R };

export interface ResolveDesktopUpdateInput<R extends ResolvableRelease> {
	policy: DesktopUpdatePolicy;
	releases: R[];
	currentVersion: string;
	now: number;
}

/**
 * Apply the policy to the cached releases.
 *
 * 1. A current version that is not semver (`dev`, an empty segment, anything a
 *    release URL could not name) is answered with nothing at all — we cannot
 *    tell whether such a build is ahead or behind, and the existing server-side
 *    check makes the same call.
 * 2. Pre-releases are invisible on the `stable` channel, and a release inside
 *    its defer window has not happened yet as far as clients are concerned.
 * 3. `paused` stops here; `pinned` takes exactly the pinned version; `latest`
 *    takes the semver-maximum of what is left.
 * 4. A target that is not strictly newer than the client is no update — which
 *    is also what keeps a pin from rolling a client backwards.
 */
export function resolveDesktopUpdate<R extends ResolvableRelease>({
	policy,
	releases,
	currentVersion,
	now,
}: ResolveDesktopUpdateInput<R>): DesktopUpdateDecision<R> {
	if (!isValidTargetVersion(currentVersion.replace(/^v/, ''))) {
		return { kind: 'none', reason: 'unparsable' };
	}
	if (policy.mode === 'paused') {
		return { kind: 'none', reason: 'paused' };
	}

	const deferMs = Math.max(0, policy.deferHours ?? 0) * 3600_000;
	const candidates = releases.filter(
		(release) =>
			isValidTargetVersion(release.version) &&
			(!release.isPrerelease || policy.channel === 'prerelease') &&
			(release.publishedAt ?? 0) + deferMs <= now
	);

	let target: R | undefined;
	if (policy.mode === 'pinned') {
		target = candidates.find((release) => release.version === policy.pinnedVersion);
		if (!target) {
			return { kind: 'none', reason: 'pinMissing' };
		}
	} else {
		target = candidates.reduce<R | undefined>(
			(best, release) =>
				best === undefined || semverCompare(release.version, best.version) > 0 ? release : best,
			undefined
		);
		if (!target) {
			return { kind: 'none', reason: 'noRelease' };
		}
	}

	if (semverCompare(target.version, currentVersion) <= 0) {
		return { kind: 'none', reason: 'current' };
	}
	return { kind: 'update', release: target };
}
