/**
 * System Updates — polling GitHub for the latest release, and caching it.
 *
 * The other half of the feature lives in `updates.ts`, which records the
 * history of updates this instance actually applied. This file is the read
 * side: `checkForUpdates` fetches the newest stable unified `v*` release, caches it
 * on the `kind='latestCheck'` singleton of the `systemUpdates` table, and
 * answers whether it is newer than what this instance is running. The public
 * query that reads that cache back — `getLatestRelease` — stays next to the
 * history it is rendered beside.
 *
 * Kept apart from `updates.ts` to hold both under the ~500 LOC cap in
 * apps/api/convex/CONVENTIONS.md. Release polling is the separable half: it
 * talks to GitHub, owns the cache TTL and the tag grammar, and shares nothing
 * with the run recorder but the table.
 *
 * Gating: platform-admin only, like everything in the pair.
 */
import { v, type ObjectType } from 'convex/values';
import { validatorDecoder } from '@owlat/worker-protocol/decodeJson';
import { GITHUB_REPO_SLUG } from '@owlat/shared/releaseArtifacts';
import { semverCompare } from '@owlat/shared/semver';
import { getOptional } from '../lib/env';
import {
	internalQuery,
	type ActionCtx,
	type MutationCtx,
	type QueryCtx,
} from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { authedAction } from '../lib/authedFunctions';
import { internal } from '../_generated/api';
import { requireAuthenticatedIdentity } from '../lib/sessionOrganization';
import { throwForbidden, throwInternal } from '../_utils/errors';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract the semver string from a GitHub release tag, but ONLY for a stable
 * release of the unified line (bare `vX.Y.Z`).
 *
 * The repo publishes three release lines from separate pipelines — the unified
 * `v*` release (server + desktop + install assets) plus target-only
 * `server-v*` and `desktop-v*` releases. Only stable unified releases are
 * marked `--latest`, so `/releases/latest` normally returns one. This guard is
 * defence in depth: a target-prefixed tag such as `server-v0.2.1` must be
 * ignored rather than mis-parsed to `0.0.0` (which would hide a real available
 * update), and a release candidate (`v0.7.0-rc.1`) is for testing and is
 * never offered as an update.
 *
 * Returns the bare version (leading `v` stripped) or `null` if the tag is not
 * a bare `vX.Y.Z` release tag.
 */
export function parseReleaseTag(tag: string): string | null {
	if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
		return null;
	}
	return tag.replace(/^v/, '');
}

/**
 * The version a GitHub release response offers as an update: its stable tag,
 * or null for a draft, a prerelease or any other tag. Installing a candidate
 * stays possible by naming it (`owlat upgrade --version X.Y.Z-rc.N`).
 */
export function offeredReleaseVersion(release: {
	tag_name?: string;
	draft?: boolean;
	prerelease?: boolean;
}): string | null {
	if (release.draft === true || release.prerelease === true) {
		return null;
	}
	return parseReleaseTag(release.tag_name || '');
}

const CHECK_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * The fields of GitHub's latest-release answer this check reads. GitHub sends
 * `body: null` for a release without notes and `published_at: null` for a draft.
 */
const decodeLatestRelease = validatorDecoder(
	v.object({
		tag_name: v.optional(v.string()),
		body: v.optional(v.union(v.string(), v.null())),
		published_at: v.optional(v.union(v.string(), v.null())),
		draft: v.optional(v.boolean()),
		prerelease: v.optional(v.boolean()),
	})
);
const GITHUB_RELEASES_URL = `https://api.github.com/repos/${GITHUB_REPO_SLUG}/releases/latest`;

// ── Internal mutations / queries (release-check cache) ───────────────────────

/** `cacheLatestRelease`'s arguments. */
export const cacheLatestReleaseArgs = {
	latestVersion: v.string(),
	releaseNotes: v.string(),
	publishedAt: v.number(),
	error: v.optional(v.string()),
};

export const cacheLatestRelease = internalMutation({
	args: cacheLatestReleaseArgs,
	handler: async (ctx, args) => await upsertLatestRelease(ctx, args),
});

/** The body of `cacheLatestRelease`. */
export async function upsertLatestRelease(
	ctx: MutationCtx,
	args: ObjectType<typeof cacheLatestReleaseArgs>
) {
	// Upsert single "latestCheck" doc per instance
	const existing = await ctx.db
		.query('systemUpdates')
		.withIndex('by_kind_and_checkedAt', (q) => q.eq('kind', 'latestCheck'))
		.order('desc')
		.first();

	const patch = {
		latestVersion: args.latestVersion,
		releaseNotes: args.releaseNotes,
		publishedAt: args.publishedAt,
		checkedAt: Date.now(),
		error: args.error,
	};

	if (existing) {
		await ctx.db.patch(existing._id, patch);
		return existing._id;
	}
	return await ctx.db.insert('systemUpdates', {
		kind: 'latestCheck',
		...patch,
	});
}

/** `cacheCheckFailure`'s arguments. */
export const cacheCheckFailureArgs = { error: v.string() };

export const cacheCheckFailure = internalMutation({
	args: cacheCheckFailureArgs,
	handler: async (ctx, args) => await recordCheckFailure(ctx, args),
});

/** The body of `cacheCheckFailure`. */
export async function recordCheckFailure(
	ctx: MutationCtx,
	args: ObjectType<typeof cacheCheckFailureArgs>
) {
	const existing = await ctx.db
		.query('systemUpdates')
		.withIndex('by_kind_and_checkedAt', (q) => q.eq('kind', 'latestCheck'))
		.order('desc')
		.first();

	if (existing) {
		await ctx.db.patch(existing._id, {
			checkedAt: Date.now(),
			error: args.error,
		});
		return existing._id;
	}
	return await ctx.db.insert('systemUpdates', {
		kind: 'latestCheck',
		checkedAt: Date.now(),
		error: args.error,
	});
}

export const getLatestCheckInternal = internalQuery({
	args: {},
	handler: async (ctx) => await readLatestCheck(ctx),
});

/** The body of `getLatestCheckInternal`. */
export async function readLatestCheck(ctx: QueryCtx) {
	return await ctx.db
		.query('systemUpdates')
		.withIndex('by_kind_and_checkedAt', (q) => q.eq('kind', 'latestCheck'))
		.order('desc')
		.first();
}

// ── Check action ─────────────────────────────────────────────────────────────

type CheckForUpdatesResult = {
	latestVersion: string | null;
	currentVersion: string;
	updateAvailable: boolean;
	releaseNotes: string | null;
	publishedAt: number | null;
	checkedAt: number;
	error: string | null;
};

/** `checkForUpdates`'s arguments. */
export const checkForUpdatesArgs = { force: v.optional(v.boolean()) };

/** `checkForUpdates`'s result. */
export const checkForUpdatesReturns = v.object({
	latestVersion: v.union(v.string(), v.null()),
	currentVersion: v.string(),
	updateAvailable: v.boolean(),
	releaseNotes: v.union(v.string(), v.null()),
	publishedAt: v.union(v.number(), v.null()),
	checkedAt: v.number(),
	error: v.union(v.string(), v.null()),
});

// authz: checkLatestRelease refuses a caller who is not a platform admin
// (isPlatformAdminByUserId) before it reads the cache or polls GitHub.
export const checkForUpdates = authedAction({
	args: checkForUpdatesArgs,
	returns: checkForUpdatesReturns,
	handler: async (ctx, args): Promise<CheckForUpdatesResult> => await checkLatestRelease(ctx, args),
});

/** The body of `checkForUpdates`. */
export async function checkLatestRelease(
	ctx: ActionCtx,
	args: ObjectType<typeof checkForUpdatesArgs>
): Promise<CheckForUpdatesResult> {
	// Action context — can't call requirePlatformAdmin (needs QueryCtx).
	// Verify admin via internal query instead.
	const identity = await requireAuthenticatedIdentity(ctx);
	const isAdmin = await ctx.runQuery(internal.platformAdmin.platformAdmin.isPlatformAdminByUserId, {
		authUserId: identity.subject,
	});
	if (!isAdmin) {
		throwForbidden('Platform admin access required');
	}

	const currentVersion = getOptional('OWLAT_VERSION') || 'dev';

	// Read cache; return stale if fresh and !force
	const cached = await ctx.runQuery(internal.maintenance.releaseCheck.getLatestCheckInternal);
	const now = Date.now();

	if (!args.force && cached?.checkedAt && now - cached.checkedAt < CHECK_CACHE_TTL_MS) {
		const latestVersion = cached.latestVersion ?? null;
		return {
			latestVersion,
			currentVersion,
			updateAvailable: latestVersion ? isNewer(latestVersion, currentVersion) : false,
			releaseNotes: cached.releaseNotes ?? null,
			publishedAt: cached.publishedAt ?? null,
			checkedAt: cached.checkedAt,
			error: cached.error ?? null,
		};
	}

	// One commit for whatever the poll learned: the release it offers, or the
	// failure. A release it does not offer writes nothing.
	const poll = await pollLatestRelease(currentVersion, now);
	if (poll.kind === 'release') {
		const { latestVersion, releaseNotes, publishedAt } = poll;
		await ctx.runMutation(internal.maintenance.releaseCheck.cacheLatestRelease, {
			latestVersion,
			releaseNotes,
			publishedAt,
		});
		return {
			latestVersion,
			currentVersion,
			updateAvailable: isNewer(latestVersion, currentVersion),
			releaseNotes,
			publishedAt,
			checkedAt: now,
			error: null,
		};
	}
	if (poll.kind === 'failed') {
		await ctx.runMutation(internal.maintenance.releaseCheck.cacheCheckFailure, {
			error: poll.error,
		});
	}

	// Nothing new to offer: answer from the cache.
	const latestVersion = cached?.latestVersion ?? null;
	return {
		latestVersion,
		currentVersion,
		updateAvailable: latestVersion ? isNewer(latestVersion, currentVersion) : false,
		releaseNotes: cached?.releaseNotes ?? null,
		publishedAt: cached?.publishedAt ?? null,
		checkedAt: now,
		error: poll.kind === 'failed' ? poll.error : null,
	};
}

/** What one poll of GitHub's latest release learned. */
type ReleasePoll =
	| { kind: 'release'; latestVersion: string; releaseNotes: string; publishedAt: number }
	| { kind: 'ignored' }
	| { kind: 'failed'; error: string };

/** Ask GitHub for the latest release. Never throws: a failure is a `failed` poll. */
async function pollLatestRelease(currentVersion: string, now: number): Promise<ReleasePoll> {
	try {
		const resp = await fetch(GITHUB_RELEASES_URL, {
			headers: {
				Accept: 'application/vnd.github+json',
				'User-Agent': `owlat-selfhost/${currentVersion}`,
				'X-GitHub-Api-Version': '2022-11-28',
			},
		});

		// Rate-limited: the answer falls back to the cache.
		if (resp.status === 403 || resp.status === 429)
			return { kind: 'failed', error: 'rate_limited' };

		if (!resp.ok) {
			throwInternal(`GitHub API returned ${resp.status}`);
		}

		const decoded = decodeLatestRelease(await resp.json());
		if (!decoded.ok) throwInternal(`GitHub returned an unexpected release (${decoded.issue})`);
		const release = decoded.value;

		const latestVersion = offeredReleaseVersion(release);
		if (!latestVersion) {
			// Not a stable `vX.Y.Z` release of the unified line (e.g. a
			// target-only `server-v*` / `desktop-v*` release, a prerelease,
			// or a missing tag). Ignore it: keep any cached version and report
			// no update rather than mis-parsing the tag to 0.0.0.
			return { kind: 'ignored' };
		}
		return {
			kind: 'release',
			latestVersion,
			releaseNotes: release.body || '',
			publishedAt: release.published_at ? new Date(release.published_at).getTime() : now,
		};
	} catch (err) {
		return { kind: 'failed', error: err instanceof Error ? err.message : 'Unknown error' };
	}
}

/**
 * True if `remote` is strictly newer than `local`. 'dev' (unreleased local
 * build) is always treated as "no update available" because we don't know
 * if the dev build is ahead or behind. Non-semver local versions are also
 * skipped.
 */
function isNewer(remote: string, local: string): boolean {
	if (local === 'dev' || local === 'unknown' || !/^\d+\.\d+\.\d+/.test(local)) {
		return false;
	}
	return semverCompare(remote, local) > 0;
}
