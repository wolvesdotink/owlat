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

/** How many release rows the cache keeps; older ones are pruned on refresh. */
export const DESKTOP_RELEASE_CACHE_LIMIT = 30;

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
