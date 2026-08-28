/**
 * IMAP FETCH — envelopes, UID sets and the raw RFC822 blob (see mail/imap/ for
 * the module overview). These are the reads that answer `FETCH` and the
 * sequence-number ↔ UID translation the server needs before `STORE`.
 */

import { v } from 'convex/values';
import { internalAction, internalQuery } from '../../_generated/server';
import { sealedBlobUrl } from '../../lib/sealedBlob';

/** Bulk envelope fetch for IMAP `FETCH 1:* (FLAGS UID INTERNALDATE ENVELOPE)`. */
export const fetchEnvelopes = internalQuery({
	args: {
		folderId: v.id('mailFolders'),
		uidLow: v.number(),
		uidHigh: v.number(),
		modseqSince: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const messages = await ctx.db
			.query('mailMessages')
			.withIndex('by_folder_and_uid', (q) =>
				q.eq('folderId', args.folderId).gte('uid', args.uidLow).lte('uid', args.uidHigh)
			)
			.collect(); // bounded: one folder's messages in a UID range

		const filtered = args.modseqSince
			? messages.filter((m) => m.modseq > (args.modseqSince ?? 0))
			: messages;

		return filtered
			.sort((a, b) => a.uid - b.uid)
			.map((m) => ({
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
			}));
	},
});

/**
 * All UIDs in a folder, ascending. The IMAP server builds its
 * per-command sequence-number ↔ UID map from this so that non-UID
 * FETCH/STORE sets are interpreted as 1-based positions and the per-row
 * `* {seq} FETCH` reply carries the true sequence number rather than a
 * fabricated 1..N counter (RFC 3501 §2.3.1.2 / §6.4.5 / §6.4.8).
 */
export const listFolderUids = internalQuery({
	args: { folderId: v.id('mailFolders') },
	handler: async (ctx, args) => {
		const messages = await ctx.db
			.query('mailMessages')
			.withIndex('by_folder_and_uid', (q) => q.eq('folderId', args.folderId))
			.collect(); // bounded: one folder's messages in a UID range
		return messages.map((m) => m.uid).sort((a, b) => a - b);
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
 * Helper: resolve the IMAP-visible message ids for a UID set. Used by
 * the IMAP server to translate `STORE 1:* +FLAGS \Seen` into the
 * concrete mailMessages ids that `storeFlags` expects.
 */
export const resolveMessageIdsByUid = internalQuery({
	args: {
		folderId: v.id('mailFolders'),
		uidLow: v.number(),
		uidHigh: v.number(),
	},
	handler: async (ctx, args) => {
		const messages = await ctx.db
			.query('mailMessages')
			.withIndex('by_folder_and_uid', (q) =>
				q.eq('folderId', args.folderId).gte('uid', args.uidLow).lte('uid', args.uidHigh)
			)
			.collect(); // bounded: one folder's messages in a UID range
		return messages
			.sort((a, b) => a.uid - b.uid)
			.map((m) => ({
				_id: m._id,
				uid: m.uid,
				modseq: m.modseq,
			}));
	},
});
