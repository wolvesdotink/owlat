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
 *     these two stay, because the operator runs 0054 by hand (self-hosting
 *     maintenance docs), so no release can assume it has completed;
 *   - ready: read the blocks (about 130k UIDs per query), checking that every
 *     page reports the same version; if the folder changed mid-walk, start
 *     again after a short backoff.
 *
 * A walk only spans several pages above ~130k messages, so only such a folder
 * can keep changing under it. After {@link MAX_ATTEMPTS} torn walks the read
 * fails with {@link MembershipUnsettledError} rather than answer from the
 * listing: that cost the whole folder in full documents on every command for
 * as long as the folder stayed busy, the cost this module exists to remove.
 * The caller already treats a failed read as temporary: NOOP and CHECK
 * complete and leave the news for the next command, an IDLE poll skips its
 * tick, and every other command answers `NO [UNAVAILABLE]`, which tells the
 * client to retry. None of them ever sees a UID list stitched from two
 * memberships.
 */

import { fn, type ConvexClient, type MembershipPage } from '../../convex.js';
import { loadFolderUids } from './folderPaging.js';

/** Folders whose UID lists are kept. A 100k-message folder costs about 1 MB. */
const MAX_CACHED_FOLDERS = 128;

/** Block pages per walk: far beyond any real folder at ~130k UIDs per page. */
const MAX_MEMBERSHIP_PAGES = 64;

/** Block walks tried, each after the folder changed under the last, before giving up. */
const MAX_ATTEMPTS = 6;

/**
 * Wait before the second walk; it doubles for each walk after that, so six
 * walks wait at most 50 + 100 + 200 + 400 + 800 ms. Each wait is jittered
 * down by up to half, so sessions torn by the same write do not retry in step.
 */
const RETRY_BASE_MS = 50;

/**
 * The folder changed between the pages of every walk {@link loadCurrentUids}
 * tried. Temporary: the next command reads it again.
 */
export class MembershipUnsettledError extends Error {
	constructor(folderId: string) {
		super(`folder ${folderId} changed during each of ${MAX_ATTEMPTS} membership walks`);
		this.name = 'MembershipUnsettledError';
	}
}

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
		if (attempt > 0) await backoff(attempt, signal);
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
	throw new MembershipUnsettledError(folderId);
}

/** Sleep before walk `attempt` (1-based retry count), or throw once `signal` aborts. */
function backoff(attempt: number, signal?: AbortSignal): Promise<void> {
	const full = RETRY_BASE_MS * 2 ** (attempt - 1);
	const ms = full / 2 + Math.random() * (full / 2);
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal!.reason);
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		signal?.addEventListener('abort', onAbort, { once: true });
	});
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
