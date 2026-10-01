/**
 * The reads `desktop/updates.ts` builds its queries and mutations from: the
 * stored policy, the release cache and the refresh state. Plain helpers over a
 * query context, with no Convex functions of their own.
 */
import type { Doc } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { getInstanceSettings } from '../lib/instanceSettings';
import {
	DEFAULT_DESKTOP_UPDATE_POLICY,
	DESKTOP_RELEASE_READ_LIMIT,
	PINNED_RELEASE_ROW_LIMIT,
	type DesktopUpdatePolicy,
} from './updateResolver';

export async function readPolicy(ctx: QueryCtx): Promise<DesktopUpdatePolicy> {
	const settings = await getInstanceSettings(ctx.db);
	const stored = settings?.desktopUpdates;
	if (!stored) return DEFAULT_DESKTOP_UPDATE_POLICY;
	return {
		mode: stored.mode,
		channel: stored.channel,
		pinnedVersion: stored.pinnedVersion,
		requiredVersion: stored.requiredVersion,
		deferHours: stored.deferHours,
	};
}

/** A release row a client could actually be served from. */
function isServable(row: Doc<'desktopReleases'>): boolean {
	return typeof row.version === 'string' && typeof row.manifest === 'string';
}

/** The cached rows of one version: at most one per release line. */
export async function readVersionRows(
	ctx: QueryCtx,
	version: string
): Promise<Doc<'desktopReleases'>[]> {
	const rows = await ctx.db
		.query('desktopReleases')
		.withIndex('by_kind_and_version', (q) => q.eq('kind', 'release').eq('version', version))
		.take(PINNED_RELEASE_ROW_LIMIT);
	return rows.filter(isServable);
}

/**
 * Every cached release. `DESKTOP_RELEASE_READ_LIMIT` covers the most rows that
 * can exist at once (see there); the index orders by version STRING, so a short
 * read could otherwise miss exactly the newest release. The pinned version's
 * rows are read again by key and merged in, so the one release the policy
 * depends on can never be the row a bounded read leaves out.
 */
export async function readReleases(
	ctx: QueryCtx,
	pinnedVersion?: string
): Promise<Doc<'desktopReleases'>[]> {
	const rows = await ctx.db
		.query('desktopReleases')
		.withIndex('by_kind_and_version', (q) => q.eq('kind', 'release'))
		.take(DESKTOP_RELEASE_READ_LIMIT);
	if (pinnedVersion) {
		const seen = new Set(rows.map((row) => row._id));
		for (const row of await readVersionRows(ctx, pinnedVersion)) {
			if (!seen.has(row._id)) rows.push(row);
		}
	}
	return rows.filter(isServable);
}

/**
 * Who last wrote the policy and when, resolved to a name for the audit line on
 * the admin page. Null before anyone has touched it — a fresh instance runs on
 * the default policy, which nobody chose.
 */
export async function readLastChange(
	ctx: QueryCtx
): Promise<{ at: number; by: string | null } | null> {
	const settings = await getInstanceSettings(ctx.db);
	const stored = settings?.desktopUpdates;
	if (!stored) return null;
	const profile = await ctx.db
		.query('userProfiles')
		.withIndex('by_auth_user_id', (q) => q.eq('authUserId', stored.updatedBy))
		.first();
	return { at: stored.updatedAt, by: profile?.name || profile?.email || null };
}

export async function readCheckState(ctx: QueryCtx): Promise<Doc<'desktopReleases'> | null> {
	return await ctx.db
		.query('desktopReleases')
		.withIndex('by_kind_and_checkedAt', (q) => q.eq('kind', 'latestCheck'))
		.order('desc')
		.first();
}
