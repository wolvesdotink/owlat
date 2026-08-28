/**
 * IMAP APPEND — register an externally-built RFC822 message (see mail/imap/ for
 * the module overview), plus the upload URL the IMAP server mints to put the
 * raw bytes in storage first.
 *
 * Every mutation here bumps the folder's `highestModseq` so CONDSTORE/QRESYNC
 * clients can resync incrementally; UID / modseq allocation stays behind these
 * functions so the IMAP server never needs to know the storage shape.
 */

import { v } from 'convex/values';
import { internalMutation } from '../../_generated/server';
import { internal } from '../../_generated/api';
import { resolveAllowedFromAddressesForCtx } from '../identities';
import { normalizeSubject } from '../../lib/emailAddress';
import { normalizeEmail } from '@owlat/shared';
import { sealBodyAtWriteMaybe } from '../../lib/messageBody';
import { isImapSystemFlag } from './flags';

/**
 * Error string used by APPEND to signal a from-address violation. The
 * IMAP server (`apps/imap/src/connection.ts`) string-matches on this
 * prefix to surface the protocol-level [NO-PERM] response instead of a
 * generic "APPEND failed".
 */
export const FROM_NOT_AUTHORIZED_ERROR = 'From address not authorized';

/** Mint an upload URL for APPEND so the IMAP server can store a raw message
 *  in file storage before recording it via `appendMessage`. */
export const generateRawUploadUrl = internalMutation({
	args: {},
	handler: async (ctx) => ctx.storage.generateUploadUrl(),
});

/**
 * APPEND — insert an externally-built RFC822 message into a folder.
 * The IMAP server has already written the bytes to ctx.storage; this
 * mutation registers the metadata row.
 */
export const appendMessage = internalMutation({
	args: {
		folderId: v.id('mailFolders'),
		rawStorageId: v.id('_storage'),
		rawSize: v.number(),
		rfc822MessageId: v.string(),
		fromAddress: v.string(),
		fromName: v.optional(v.string()),
		toAddresses: v.array(v.string()),
		ccAddresses: v.array(v.string()),
		bccAddresses: v.array(v.string()),
		subject: v.string(),
		snippet: v.string(),
		htmlBodyInline: v.optional(v.string()),
		textBodyInline: v.optional(v.string()),
		internalDate: v.optional(v.number()),
		flags: v.optional(v.array(v.string())),
	},
	handler: async (ctx, args) => {
		const folder = await ctx.db.get(args.folderId);
		if (!folder) throw new Error('Folder not found');
		const mailbox = await ctx.db.get(folder.mailboxId);
		if (!mailbox || mailbox.status !== 'active') {
			throw new Error('Mailbox not active');
		}

		// Block forged-From APPENDs: the From header parsed from the
		// appended bytes must be an address the mailbox is authorised to
		// send as. Without this an authenticated user could populate their
		// own Sent folder with a fabricated "From: ceo@org.com" entry that
		// later flows into "resend from Sent" UI as a real spoof.
		const allowedFrom = await resolveAllowedFromAddressesForCtx(ctx, folder.mailboxId);
		if (!allowedFrom.includes(normalizeEmail(args.fromAddress))) {
			throw new Error(FROM_NOT_AUTHORIZED_ERROR);
		}

		const now = Date.now();
		const internalDate = args.internalDate ?? now;
		const uid = folder.uidNext;
		const modseq = folder.highestModseq + 1;

		const flagSet = new Set((args.flags ?? []).map((f) => f.toLowerCase()));
		const customFlags: string[] = [];
		for (const f of args.flags ?? []) {
			if (!isImapSystemFlag(f.toLowerCase())) customFlags.push(f);
		}

		// Create or reuse a thread for the appended message. APPEND is most
		// commonly used for client-side draft saves, so default to a fresh
		// thread when there's no inReplyTo.
		const normalizedSubject = normalizeSubject(args.subject);
		const threadId = await ctx.db.insert('mailThreads', {
			mailboxId: folder.mailboxId,
			normalizedSubject,
			participants: [args.fromAddress, ...args.toAddresses],
			messageCount: 1,
			unreadCount: flagSet.has('\\seen') ? 0 : 1,
			hasFlagged: flagSet.has('\\flagged'),
			hasAttachments: false,
			lastMessageAt: internalDate,
			firstMessageAt: internalDate,
			latestSnippet: args.snippet,
			latestFromAddress: args.fromAddress,
			latestSubject: args.subject,
			folderRoles: folder.role ? [folder.role] : [],
			labelIds: [],
			createdAt: now,
			updatedAt: now,
		});

		const messageId = await ctx.db.insert('mailMessages', {
			mailboxId: folder.mailboxId,
			folderId: folder._id,
			uid,
			modseq,
			rfc822MessageId: args.rfc822MessageId,
			threadId,
			fromAddress: args.fromAddress,
			fromName: args.fromName,
			toAddresses: args.toAddresses,
			ccAddresses: args.ccAddresses,
			bccAddresses: args.bccAddresses,
			subject: args.subject,
			normalizedSubject,
			snippet: args.snippet,
			rawStorageId: args.rawStorageId,
			rawSize: args.rawSize,
			textBodyInline: await sealBodyAtWriteMaybe(args.textBodyInline),
			htmlBodyInline: await sealBodyAtWriteMaybe(args.htmlBodyInline),
			attachments: [],
			hasAttachments: false,
			flagSeen: flagSet.has('\\seen'),
			flagFlagged: flagSet.has('\\flagged'),
			flagAnswered: flagSet.has('\\answered'),
			flagDraft: flagSet.has('\\draft') || folder.role === 'drafts',
			flagDeleted: flagSet.has('\\deleted'),
			customFlags,
			labelIds: [],
			receivedAt: internalDate,
			internalDate,
			createdAt: now,
			updatedAt: now,
		});

		// The conversation list links to latestMessageId; set it now that the
		// appended message exists.
		await ctx.db.patch(threadId, { latestMessageId: messageId });

		// E8b: the IMAP server uploads the raw `.eml` straight to storage
		// (plaintext), so seal it at rest out-of-band — a mutation can't read/re-store
		// a blob's bytes. Idempotent + resumable; the accessor + `/sealed-blob` proxy
		// serve it correctly in the meantime (mixed-state tolerance).
		await ctx.scheduler.runAfter(
			0,
			internal.migrations['0035_seal_bodies_at_rest'].resealMessageBlobs,
			{ id: messageId }
		);

		await ctx.db.patch(folder._id, {
			uidNext: uid + 1,
			highestModseq: modseq,
			totalCount: folder.totalCount + 1,
			unseenCount: folder.unseenCount + (flagSet.has('\\seen') ? 0 : 1),
			updatedAt: now,
		});
		await ctx.db.patch(mailbox._id, {
			usedBytes: mailbox.usedBytes + args.rawSize,
			updatedAt: now,
		});

		return {
			messageId,
			uid,
			uidValidity: folder.uidValidity,
			modseq,
		};
	},
});
