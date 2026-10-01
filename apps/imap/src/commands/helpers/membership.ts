/**
 * The SELECTed folder's current UIDs, ascending, reused across commands and
 * connections while the folder's membership has not changed (#927).
 *
 * Every message-set command used to list the whole folder through
 * `listFolderUidsPage`: in a 100k-message folder, 101 queries and 100k full
 * `mailMessages` documents for a one-message FETCH. The backend now keeps the
 * folder's UIDs in a compact block table with a membership version that every
 * insert, move and delete bumps in the same transaction
 * (apps/api `mail/folderMembership.ts`). This module caches a folder's UID list
 * under that version and asks the backend, in one small query, whether it is
 * still current. A cached list is used only when the backend says the version
 * has not moved, so it is always exactly what a fresh listing would return:
 * another session's EXPUNGE changes the version, and the next command reloads.
 *
 * Fallbacks, in the order the backend's answer selects them:
 *   - folder not maintained (the 0054 backfill has not reached it): list
 *     `mailMessages` as before, and cache nothing;
 *   - backfill still under way: list `mailMessages`, and cache the result
 *     only if the version did not move while the pages were read (the pages
 *     are separate transactions; an unmoved version means none of them saw a
 *     membership change, so together they are one consistent listing);
 *   - ready: read the blocks (about 130k UIDs per query), checking that every
 *     page reports the same version; if the folder changed mid-walk, start
 *     again, and after {@link MAX_ATTEMPTS} fall back to the listing.
 */

import { fn, type ConvexClient, type MembershipPage } from '../../convex.js';
import { loadFolderUids } from './folderPaging.js';

/** Folders whose UID lists are kept. A 100k-message folder costs about 1 MB. */
const MAX_CACHED_FOLDERS = 128;

/** Block pages per walk: far beyond any real folder at ~130k UIDs per page. */
const MAX_MEMBERSHIP_PAGES = 64;

/** Walks restarted because the folder changed under them before giving up. */
const MAX_ATTEMPTS = 3;

interface CachedMembership {
	readonly version: string;
	readonly uids: readonly number[];
}

/** Insertion order is recency: a hit moves the folder to the end. */
const cache = new Map<string, CachedMembership>();

function remember(folderId: string, entry: CachedMembership): void {
	cache.delete(folderId);
	cache.set(folderId, entry);
	while (cache.size > MAX_CACHED_FOLDERS) {
		const oldest = cache.keys().next().value;
		if (oldest === undefined) break;
		cache.delete(oldest);
	}
}

/** Drop every cached folder. Tests share one process-wide cache. */
export function forgetCachedMemberships(): void {
	cache.clear();
}

/**
 * The folder's UIDs ascending, as of one consistent point in time. The array
 * is shared (between commands and sessions), so callers must not mutate it.
 */
export async function loadCurrentUids(
	convex: ConvexClient,
	folderId: string,
	signal?: AbortSignal
): Promise<readonly number[]> {
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
		signal?.throwIfAborted();
		const cached = cache.get(folderId);
		const head = await convex.query(fn.folderMembershipPage, {
			folderId,
			...(cached ? { knownVersion: cached.version } : {}),
		});
		if (head === null) return await loadFolderUids(convex, folderId, signal);
		if (head.unchanged && cached) {
			remember(folderId, cached);
			return cached.uids;
		}
		if (!head.isReady) {
			const uids = await loadFolderUids(convex, folderId, signal);
			const after = await convex.query(fn.folderMembershipPage, {
				folderId,
				knownVersion: head.version,
			});
			if (after?.unchanged) remember(folderId, { version: head.version, uids });
			return uids;
		}
		const uids = await readBlocks(convex, folderId, head, signal);
		if (uids !== null) {
			remember(folderId, { version: head.version, uids });
			return uids;
		}
	}
	// The folder kept changing under the walk: answer from the listing, as every
	// command did before, without caching it.
	return await loadFolderUids(convex, folderId, signal);
}

/**
 * Concatenate the block pages that follow `first`, or `null` if a later page
 * belongs to a different version (the folder changed between two pages).
 */
async function readBlocks(
	convex: ConvexClient,
	folderId: string,
	first: NonNullable<MembershipPage>,
	signal?: AbortSignal
): Promise<number[] | null> {
	const uids: number[] = [];
	let page = first;
	for (let n = 0; n < MAX_MEMBERSHIP_PAGES; n += 1) {
		for (const block of page.blocks ?? []) {
			for (const uid of block) uids.push(uid);
		}
		const after = page.nextFirstUid;
		if (after === undefined || after === null) return uids;
		signal?.throwIfAborted();
		const next = await convex.query(fn.folderMembershipPage, { folderId, afterFirstUid: after });
		if (next === null || !next.isReady || next.version !== first.version) return null;
		page = next;
	}
	throw new Error(`folderMembershipPage: exceeded ${MAX_MEMBERSHIP_PAGES} pages`);
}
