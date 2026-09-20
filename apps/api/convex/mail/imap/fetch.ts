/**
 * IMAP FETCH — envelopes, UID sets and the raw RFC822 blob (see mail/imap/ for
 * the module overview). These are the reads that answer `FETCH` and the
 * sequence-number ↔ UID translation the server needs before `STORE`.
 *
 * Every folder-scoped read here is a PAGE, never the folder. Convex reads whole
 * documents (a `mailMessages` row carries its attachment metadata) and caps one
 * function execution at 16,384 documents / 8 MiB, so a single `.collect()` over
 * a folder is not a slow path — on a real INBOX it is a hard failure. The
 * sidecar (`apps/imap`) drives the paging: each query returns at most one page
 * plus the cursor to resume from, and `nextUid === null` means the caller has
 * seen the whole requested window.
 */

import { paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';
import type { Doc } from '../../_generated/dataModel';
import { internalAction, internalQuery } from '../../_generated/server';
import { sealedBlobUrl } from '../../lib/sealedBlob';

/**
 * Rows per page. UID-ordered pages are resumed by `uid` (unique within a
 * folder), so the page size is purely a read-budget knob: small enough that a
 * page of full documents stays far below the per-execution limits, large enough
 * that a typical `FETCH 1:*` is a handful of round trips rather than hundreds.
 */
const DEFAULT_PAGE_SIZE = 200;
const MAX_PAGE_SIZE = 500;

function pageSize(requested: number | undefined): number {
	if (requested === undefined) return DEFAULT_PAGE_SIZE;
	return Math.max(1, Math.min(Math.floor(requested), MAX_PAGE_SIZE));
}

/**
 * `nextUid` for a UID-ordered page: the UID to resume from when the page came
 * back full, `null` once the window is exhausted. A short page can only mean
 * the index range ran out, because the range scan is ordered.
 */
function nextUid(rows: ReadonlyArray<{ uid: number }>, limit: number): number | null {
	if (rows.length < limit) return null;
	const last = rows[rows.length - 1];
	return last === undefined ? null : last.uid + 1;
}

/** The IMAP-visible projection of a message row. */
function toEnvelope(m: Doc<'mailMessages'>) {
	return {
		_id: m._id,
		uid: m.uid,
		modseq: m.modseq,
		rawSize: m.rawSize,
		rfc822MessageId: m.rfc822MessageId,
		inReplyTo: m.inReplyTo,
		references: m.references,
		fromAddress: m.fromAddress,
		fromName: m.fromName,
		toAddresses: m.toAddresses,
		ccAddresses: m.ccAddresses,
		bccAddresses: m.bccAddresses,
		replyToAddress: m.replyToAddress,
		subject: m.subject,
		internalDate: m.internalDate,
		attachments: m.attachments,
		hasAttachments: m.hasAttachments,
		flagSeen: m.flagSeen,
		flagFlagged: m.flagFlagged,
		flagAnswered: m.flagAnswered,
		flagDraft: m.flagDraft,
		flagDeleted: m.flagDeleted,
		customFlags: m.customFlags,
	};
}

/**
 * One page of envelopes inside a UID window, ascending — the read behind
 * `FETCH <set> (FLAGS UID INTERNALDATE ENVELOPE)`. The caller passes the
 * window it actually asked for and re-issues from `nextUid` until that comes
 * back `null`, so a `FETCH 1:*` over a big folder is N bounded reads instead of
 * one read of everything.
 */
export const fetchEnvelopes = internalQuery({
	args: {
		folderId: v.id('mailFolders'),
		uidLow: v.number(),
		uidHigh: v.number(),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const limit = pageSize(args.limit);
		const rows = await ctx.db
			.query('mailMessages')
			.withIndex('by_folder_and_uid', (q) =>
				q.eq('folderId', args.folderId).gte('uid', args.uidLow).lte('uid', args.uidHigh)
			)
			.take(limit);
		// The index walks `uid` ascending, so the page is already in IMAP order.
		return { rows: rows.map(toEnvelope), nextUid: nextUid(rows, limit) };
	},
});

/**
 * One page of the rows whose `modseq` advanced past `modseqSince`, for
 * CONDSTORE `CHANGEDSINCE` and the IDLE poll (RFC 7162). Served off
 * `by_folder_and_modseq` — the alternative, reading a UID window and dropping
 * the unchanged rows in JS, reads the whole folder to answer "what changed in
 * the last five seconds", which is exactly the question an index answers.
 *
 * Paged with Convex cursors rather than a `> lastSeenModseq` watermark: today's
 * write paths hand every touched row its own incremented modseq, but nothing in
 * the schema enforces that, and a watermark resume silently drops rows sharing
 * the boundary value. A cursor is exact whatever the modseq allocation does.
 */
export const fetchChangedEnvelopes = internalQuery({
	args: {
		folderId: v.id('mailFolders'),
		modseqSince: v.number(),
		paginationOpts: paginationOptsValidator,
	},
	handler: async (ctx, args) => {
		const result = await ctx.db
			.query('mailMessages')
			.withIndex('by_folder_and_modseq', (q) =>
				q.eq('folderId', args.folderId).gt('modseq', args.modseqSince)
			)
			.paginate(args.paginationOpts);
		return { ...result, page: result.page.map(toEnvelope) };
	},
});

/**
 * One page of a folder's UIDs, ascending. The IMAP server builds its
 * per-command sequence-number ↔ UID map from the concatenated pages so that
 * non-UID FETCH/STORE sets are interpreted as 1-based positions and the per-row
 * `* {seq} FETCH` reply carries the true sequence number rather than a
 * fabricated 1..N counter (RFC 3501 §2.3.1.2 / §6.4.5 / §6.4.8).
 *
 * The sidecar genuinely needs the whole ordered UID set to do that, but it
 * needs only the UIDs — so this pages, and each execution reads at most
 * `limit` rows. Resume from `nextUid` until it is `null`.
 */
export const listFolderUidsPage = internalQuery({
	args: {
		folderId: v.id('mailFolders'),
		afterUid: v.optional(v.number()),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const limit = pageSize(args.limit);
		const after = args.afterUid;
		const rows = await ctx.db
			.query('mailMessages')
			.withIndex('by_folder_and_uid', (q) =>
				after === undefined
					? q.eq('folderId', args.folderId)
					: q.eq('folderId', args.folderId).gte('uid', after)
			)
			.take(limit);
		return { uids: rows.map((m) => m.uid), nextUid: nextUid(rows, limit) };
	},
});

/** For `FETCH RFC822` / `BODY[]` — IMAP server uses the storage id to
 *  stream the raw .eml from Convex storage. */
export const fetchRawStorageId = internalQuery({
	args: { messageId: v.id('mailMessages') },
	handler: async (ctx, args) => {
		const m = await ctx.db.get(args.messageId);
		if (!m) return null;
		return {
			storageId: m.rawStorageId,
			rawSize: m.rawSize,
			internalDate: m.internalDate,
			folderId: m.folderId,
			uid: m.uid,
		};
	},
});

/** Resolve a time-limited download URL for a stored raw RFC822 message.
 *  Consumed by the IMAP server's FETCH (apps/imap) to stream message bodies —
 *  storage URLs can only be minted inside a Convex function (there is no
 *  client-addressable `_storage` module to call from ConvexHttpClient). */
export const getRawStorageUrl = internalAction({
	args: { storageId: v.id('_storage') },
	// E8b: the raw `.eml` is sealed at rest, so hand the IMAP server a
	// decrypt-serving proxy URL — its `FETCH RFC822` stream then receives the
	// plaintext RFC822 bytes, unchanged from the bare storage URL it used before.
	handler: async (ctx, args) => sealedBlobUrl(ctx.storage, args.storageId, 'message/rfc822'),
});

/**
 * Helper: one page of the IMAP-visible message ids for a UID window. Used by
 * the IMAP server to translate `STORE 1:* +FLAGS \Seen` into the concrete
 * mailMessages ids that `storeFlags` expects — `1:*` is a whole-folder window,
 * so this pages the same way `fetchEnvelopes` does.
 */
export const resolveMessageIdsByUid = internalQuery({
	args: {
		folderId: v.id('mailFolders'),
		uidLow: v.number(),
		uidHigh: v.number(),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const limit = pageSize(args.limit);
		const rows = await ctx.db
			.query('mailMessages')
			.withIndex('by_folder_and_uid', (q) =>
				q.eq('folderId', args.folderId).gte('uid', args.uidLow).lte('uid', args.uidHigh)
			)
			.take(limit);
		return {
			rows: rows.map((m) => ({ _id: m._id, uid: m.uid, modseq: m.modseq })),
			nextUid: nextUid(rows, limit),
		};
	},
});
