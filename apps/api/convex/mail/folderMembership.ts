/**
 * Folder membership for the IMAP sequence map (#927), behind
 * `mailFolderMembership` and `mailFolderUidBlocks` (schema/mailFolderMembership.ts).
 *
 * A non-UID IMAP command addresses messages by position, so the IMAP server
 * needs a folder's ordered UID list. Listing it from `mailMessages` reads every
 * message document in the folder: in a 100k-message INBOX that is 100k full
 * rows for a one-message FETCH. Here the UIDs live in blocks of up to
 * {@link MEMBERSHIP_BLOCK_SIZE}, and the folder's state row carries a revision.
 *
 * ── KEPT IN STEP ─────────────────────────────────────────────────────────────
 * {@link recordFolderMembership} is the one hook. Every write that inserts,
 * deletes, or changes the `folderId` or `uid` of a message calls it, in the
 * same mutation, with the row before and after the write: the inserts (delivery,
 * APPEND, IMAP COPY, the Sent copy), the moves (`moveMessagesToFolder`, IMAP
 * MOVE, folder deletion, follow-up return) and `deleteMessageRowAndBlobs`, the
 * only delete of a message. It bumps the revision whenever the folder has a
 * state row, so a revision that has not moved means the folder holds exactly
 * the UIDs it held before; the IMAP server only reuses a cached map on that
 * condition. Because the hook and the message write commit together, there is
 * no half-applied membership update to recover from.
 *
 * ── BACKFILL WITHOUT A RACE ──────────────────────────────────────────────────
 * Folders that existed before this table are filled by a paged walk over
 * `by_folder_and_uid` (`maintenance/folderMembershipBackfill.ts`), the same
 * scheme as the counters (`lib/counters.ts`): the state row stores the position
 * `(uid, _creationTime)` of the last message the walk added, and a write only
 * touches the blocks for a message at or before it. Anything past it is left to
 * the walk, which reads it in whatever state it is in when it gets there. Until
 * the walk finishes the folder is not ready and the IMAP server keeps listing
 * `mailMessages`, so a deployment mid-backfill answers exactly as before.
 *
 * A folder with no state row is not maintained at all (nothing reads or writes
 * its blocks). New folders start ready and empty.
 */

import type { Doc, Id } from '../_generated/dataModel';
import type { DatabaseReader, MutationCtx } from '../_generated/server';
import { AFTER_EVERY_ROW, isCountedPosition, type CounterPosition } from '../lib/counters';

/** UIDs per block. Small enough that the per-message read and rewrite stays a few KB. */
export const MEMBERSHIP_BLOCK_SIZE = 256;

/** A block that falls below this after a removal absorbs the next one if both fit. */
const MERGE_BELOW = MEMBERSHIP_BLOCK_SIZE / 4;

/** Blocks deleted per call when a folder's membership is dropped. */
const DROP_BATCH = 256;

/** Messages per backfill step. Old rows may still carry inline bodies, as in the counter walk. */
const BACKFILL_PAGE = 64;

/** The fields of a message its folder membership depends on. */
export type MembershipRow = Pick<Doc<'mailMessages'>, 'folderId' | 'uid'> & {
	_creationTime?: number;
};

export async function loadFolderMembership(
	db: DatabaseReader,
	folderId: Id<'mailFolders'>
): Promise<Doc<'mailFolderMembership'> | null> {
	return db
		.query('mailFolderMembership')
		.withIndex('by_folder', (q) => q.eq('folderId', folderId))
		.first();
}

/**
 * The token the IMAP server caches a folder's map under. The state row's id is
 * part of it, so a membership dropped and rebuilt can never repeat a version
 * an old map was cached under.
 */
export function membershipVersion(state: Doc<'mailFolderMembership'>): string {
	return `${state._id}:${state.revision}`;
}

/**
 * Start maintaining a folder. `isEmpty` marks a folder created just now: it
 * holds no mail, so it is ready at once. Idempotent — an existing state row is
 * left alone and its state returned.
 */
export async function startFolderMembership(
	ctx: MutationCtx,
	folderId: Id<'mailFolders'>,
	options: { isEmpty?: boolean } = {}
): Promise<'ready' | 'running' | 'started'> {
	const existing = await loadFolderMembership(ctx.db, folderId);
	if (existing) return existing.isReady ? 'ready' : 'running';
	const now = Date.now();
	const isReady = options.isEmpty === true;
	await ctx.db.insert('mailFolderMembership', {
		folderId,
		isReady,
		revision: 0,
		cursor: null,
		startedAt: now,
		completedAt: isReady ? now : undefined,
		updatedAt: now,
	});
	return isReady ? 'ready' : 'started';
}

/**
 * Walk a folder again from scratch, the repair for blocks found out of step.
 * The folder stops being ready, its cursor and watermark go back to the start
 * (so no write touches the blocks until the walk passes it again), and the
 * revision moves, so no IMAP server keeps a map it cached from the old blocks.
 * The walk's first step clears the old blocks before it adds any. Starts a
 * folder that has no state row yet.
 */
export async function resetFolderMembership(
	ctx: MutationCtx,
	folderId: Id<'mailFolders'>
): Promise<void> {
	const state = await loadFolderMembership(ctx.db, folderId);
	if (!state) {
		await startFolderMembership(ctx, folderId);
		return;
	}
	const now = Date.now();
	await ctx.db.patch(state._id, {
		isReady: false,
		revision: state.revision + 1,
		cursor: null,
		watermark: undefined,
		startedAt: now,
		completedAt: undefined,
		updatedAt: now,
	});
}

/**
 * Stop maintaining a folder that is being deleted: the state row first, so no
 * later write or queued backfill step touches the blocks, then up to one batch
 * of blocks. The folder is already empty by then, so its blocks are gone and
 * this finds none. Returns true while blocks remain.
 */
export async function dropFolderMembership(
	ctx: MutationCtx,
	folderId: Id<'mailFolders'>
): Promise<boolean> {
	const state = await loadFolderMembership(ctx.db, folderId);
	if (state) await ctx.db.delete(state._id);
	const blocks = await ctx.db
		.query('mailFolderUidBlocks')
		.withIndex('by_folder_and_first_uid', (q) => q.eq('folderId', folderId))
		.take(DROP_BATCH);
	for (const block of blocks) await ctx.db.delete(block._id);
	return blocks.length === DROP_BATCH;
}

/**
 * Move a message's folder membership for one write: `before` is the row as it
 * was (null for an insert), `after` as written (null for a delete). For a move,
 * `after` carries the target folder AND the UID allocated there. Call it in the
 * same mutation as the write.
 */
export async function recordFolderMembership(
	ctx: MutationCtx,
	before: MembershipRow | null,
	after: MembershipRow | null
): Promise<void> {
	if (before && after && before.folderId === after.folderId && before.uid === after.uid) return;
	if (before) await applyMembershipChange(ctx, before, 'remove');
	if (after) await applyMembershipChange(ctx, after, 'add');
}

async function applyMembershipChange(
	ctx: MutationCtx,
	row: MembershipRow,
	change: 'add' | 'remove'
): Promise<void> {
	const state = await loadFolderMembership(ctx.db, row.folderId);
	if (!state) return;
	// `updatedAt` stays the walk's: 0054's `finish` reads it to find a walk that
	// stopped moving, and mail arriving in the folder says nothing about that.
	await ctx.db.patch(state._id, { revision: state.revision + 1 });
	const position: CounterPosition = {
		key: row.uid,
		creationTime: row._creationTime ?? AFTER_EVERY_ROW,
	};
	if (!state.isReady && !isCountedPosition(position, state.watermark)) return;
	if (change === 'add') await addUid(ctx, row.folderId, row.uid);
	else await removeUid(ctx, row.folderId, row.uid);
}

// ── Blocks ──────────────────────────────────────────────────────────────────
// Blocks of one folder are ordered by `firstUid`, and each holds the UIDs from
// its bound up to (not including) the next block's bound. So the block for a
// UID is the one with the greatest bound at or below it, and concatenating the
// blocks in index order gives the folder's UIDs ascending.

/** Index of the first entry of `uids` (ascending) that is `>= target`. */
function lowerBound(uids: readonly number[], target: number): number {
	let lo = 0;
	let hi = uids.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if ((uids[mid] ?? 0) < target) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

async function blockAtOrBelow(
	db: DatabaseReader,
	folderId: Id<'mailFolders'>,
	uid: number
): Promise<Doc<'mailFolderUidBlocks'> | null> {
	return db
		.query('mailFolderUidBlocks')
		.withIndex('by_folder_and_first_uid', (q) => q.eq('folderId', folderId).lte('firstUid', uid))
		.order('desc')
		.first();
}

async function addUid(ctx: MutationCtx, folderId: Id<'mailFolders'>, uid: number): Promise<void> {
	// Below every bound (or no blocks yet): the first block takes it and lowers its bound.
	const block =
		(await blockAtOrBelow(ctx.db, folderId, uid)) ??
		(await ctx.db
			.query('mailFolderUidBlocks')
			.withIndex('by_folder_and_first_uid', (q) => q.eq('folderId', folderId))
			.first());
	if (!block) {
		await ctx.db.insert('mailFolderUidBlocks', { folderId, firstUid: uid, uids: [uid] });
		return;
	}
	const uids = block.uids.slice();
	const at = lowerBound(uids, uid + 1);
	uids.splice(at, 0, uid);
	const firstUid = Math.min(block.firstUid, uid);
	if (uids.length <= MEMBERSHIP_BLOCK_SIZE) {
		await ctx.db.patch(block._id, { firstUid, uids });
		return;
	}
	// Full. An append (new mail takes `uidNext`, above everything) starts the
	// next block and leaves this one full; anything else splits it in half. The
	// cut never separates two copies of one UID, so every UID has one block.
	let cut = at === uids.length - 1 ? at : uids.length >>> 1;
	while (cut > 0 && uids[cut - 1] === uids[cut]) cut -= 1;
	if (cut === 0) {
		await ctx.db.patch(block._id, { firstUid, uids });
		return;
	}
	await ctx.db.patch(block._id, { firstUid, uids: uids.slice(0, cut) });
	await ctx.db.insert('mailFolderUidBlocks', {
		folderId,
		firstUid: uids[cut]!,
		uids: uids.slice(cut),
	});
}

async function removeUid(ctx: MutationCtx, folderId: Id<'mailFolders'>, uid: number) {
	const block = await blockAtOrBelow(ctx.db, folderId, uid);
	if (!block) return;
	const at = lowerBound(block.uids, uid);
	if (block.uids[at] !== uid) return;
	const uids = block.uids.slice();
	uids.splice(at, 1);
	if (uids.length === 0) {
		await ctx.db.delete(block._id);
		return;
	}
	// Expunges scattered over a folder would otherwise leave many near-empty
	// blocks behind, and every listing reads each of them.
	if (uids.length < MERGE_BELOW) {
		const next = await ctx.db
			.query('mailFolderUidBlocks')
			.withIndex('by_folder_and_first_uid', (q) =>
				q.eq('folderId', folderId).gt('firstUid', block.firstUid)
			)
			.first();
		if (next && uids.length + next.uids.length <= MEMBERSHIP_BLOCK_SIZE) {
			await ctx.db.patch(block._id, { uids: [...uids, ...next.uids] });
			await ctx.db.delete(next._id);
			return;
		}
	}
	await ctx.db.patch(block._id, { uids });
}

/**
 * Up to `limit` blocks of a folder after the bound `afterFirstUid`, ascending.
 * Only meaningful for a ready folder.
 */
export async function readMembershipBlocks(
	db: DatabaseReader,
	folderId: Id<'mailFolders'>,
	afterFirstUid: number | undefined,
	limit: number
): Promise<Doc<'mailFolderUidBlocks'>[]> {
	return db
		.query('mailFolderUidBlocks')
		.withIndex('by_folder_and_first_uid', (q) =>
			afterFirstUid === undefined
				? q.eq('folderId', folderId)
				: q.eq('folderId', folderId).gt('firstUid', afterFirstUid)
		)
		.take(limit);
}

// ── Backfill ────────────────────────────────────────────────────────────────

/**
 * Add one page of a folder's messages to its blocks and advance the cursor and
 * watermark; the last page marks the folder ready. Returns true while there is
 * more to walk. Every step is its own transaction and reads its cursor from the
 * state row, so a walk that dies resumes at the page after the last one that
 * committed. Exported with a page-size override so a test can interleave
 * writes with a walk a few rows at a time.
 *
 * A walk that has not added its first page yet owns no blocks: any it finds
 * are left from before a reset (or an earlier drop that did not finish), and
 * it deletes them a batch per step before it starts. No write adds to the
 * blocks meanwhile, because no message is at or before an unset watermark.
 */
export async function runFolderMembershipBackfillStep(
	ctx: MutationCtx,
	folderId: Id<'mailFolders'>,
	pageSize: number = BACKFILL_PAGE
): Promise<boolean> {
	const state = await loadFolderMembership(ctx.db, folderId);
	if (!state || state.isReady) return false;
	if (state.cursor === null) {
		const leftover = await readMembershipBlocks(ctx.db, folderId, undefined, DROP_BATCH);
		if (leftover.length > 0) {
			for (const block of leftover) await ctx.db.delete(block._id);
			await ctx.db.patch(state._id, { updatedAt: Date.now() });
			return true;
		}
	}
	const page = await ctx.db
		.query('mailMessages')
		.withIndex('by_folder_and_uid', (q) => q.eq('folderId', folderId))
		.paginate({ cursor: state.cursor, numItems: pageSize });
	for (const message of page.page) await addUid(ctx, folderId, message.uid);

	const now = Date.now();
	if (page.isDone) {
		await ctx.db.patch(state._id, {
			isReady: true,
			cursor: null,
			watermark: undefined,
			completedAt: now,
			updatedAt: now,
		});
		return false;
	}
	const last = page.page[page.page.length - 1];
	await ctx.db.patch(state._id, {
		cursor: page.continueCursor,
		watermark: last ? { key: last.uid, creationTime: last._creationTime } : state.watermark,
		updatedAt: now,
	});
	return true;
}
