/**
 * The writes of the desktop release refresh (`desktop/updates.ts`,
 * `refreshReleases`): cache a release, prune the cache, record the check. The
 * refresh lists and downloads first, then lands everything it learned in
 * `commitRefresh`, so a refresh that dies partway leaves no half-pruned cache
 * and no check stamped for releases that were never stored.
 */
import { v, type Infer } from 'convex/values';
import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { readCheckState, readPolicy } from './updateReads';
import { DESKTOP_RELEASE_CACHE_LIMIT, releasesToPrune } from './updateResolver';

/** One release's validated `latest.json` and listing metadata, as cached. */
export const cachedReleaseValidator = v.object({
	tag: v.string(),
	version: v.string(),
	line: v.union(v.literal('unified'), v.literal('desktop')),
	isPrerelease: v.boolean(),
	publishedAt: v.number(),
	notes: v.string(),
	manifest: v.string(),
});
export type CachedRelease = Infer<typeof cachedReleaseValidator>;

export async function cacheReleaseRow(
	ctx: MutationCtx,
	release: CachedRelease
): Promise<Id<'desktopReleases'>> {
	// Keyed by tag, not version: `refreshReleases` decides what is new by tag,
	// and two release lines can legitimately publish the same version.
	const existing = await ctx.db
		.query('desktopReleases')
		.withIndex('by_kind_and_tag', (q) => q.eq('kind', 'release').eq('tag', release.tag))
		.first();
	const row = { kind: 'release' as const, ...release, fetchedAt: Date.now() };
	if (existing) {
		await ctx.db.patch(existing._id, row);
		return existing._id;
	}
	return await ctx.db.insert('desktopReleases', row);
}

export async function recordCheckState(ctx: MutationCtx, error: string | undefined): Promise<void> {
	const existing = await readCheckState(ctx);
	const patch = { checkedAt: Date.now(), error };
	if (existing) {
		await ctx.db.patch(existing._id, patch);
		return;
	}
	await ctx.db.insert('desktopReleases', { kind: 'latestCheck', ...patch });
}

/**
 * Keep the newest `DESKTOP_RELEASE_CACHE_LIMIT` releases plus the pinned one and
 * the retained stable ones; drop the rest. The policy is read in the same transaction, so a pin saved
 * concurrently either lands first and is kept, or conflicts and retries.
 */
export async function pruneReleaseCache(ctx: MutationCtx): Promise<void> {
	const [policy, rows] = await Promise.all([
		readPolicy(ctx),
		ctx.db
			.query('desktopReleases')
			.withIndex('by_kind_and_version', (q) => q.eq('kind', 'release'))
			.take(DESKTOP_RELEASE_CACHE_LIMIT * 4),
	]);
	for (const row of releasesToPrune(rows, policy, Date.now())) {
		await ctx.db.delete(row._id);
	}
}

/**
 * The one commit of a refresh: the releases it downloaded, the prune, and the
 * check with its error, if any. The prune is skipped when the first listing
 * page failed or the walk threw, so such a refresh changes the cache by what
 * it downloaded and nothing else. A failure on a later page still prunes.
 */
export const commitRefresh = internalMutation({
	args: {
		releases: v.array(cachedReleaseValidator),
		prune: v.boolean(),
		error: v.optional(v.string()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		for (const release of args.releases) {
			await cacheReleaseRow(ctx, release);
		}
		if (args.prune) await pruneReleaseCache(ctx);
		await recordCheckState(ctx, args.error);
		return null;
	},
});
