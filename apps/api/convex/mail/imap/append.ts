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
import { mergeThreadParticipants, rebuildThreadAggregates } from '../threadAggregates';
import { conversationRootId, resolveDeliveryThread } from '../deliveryPipeline/threading';
import { clearNeedsReplyOnOwnerReply } from '../needsReply';
import { buildSearchBody, isBodySearchIndexingEnabled } from '../searchBody';
import { buildSnippet } from '../deliveryPipeline/insert';
import { applyMailboxUsageDelta } from '../mailboxUsage';

/**
 * Error string used by APPEND to signal a from-address violation. The
 * IMAP server (`apps/imap/src/connection.ts`) string-matches on this
 * prefix to surface the protocol-level [NO-PERM] response instead of a
 * generic "APPEND failed".
 */
const FROM_NOT_AUTHORIZED_ERROR = 'From address not authorized';

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
		/** Bare Message-IDs from the In-Reply-To / References headers. */
		inReplyTo: v.optional(v.string()),
		references: v.optional(v.array(v.string())),
		fromAddress: v.string(),
		fromName: v.optional(v.string()),
		toAddresses: v.array(v.string()),
		ccAddresses: v.array(v.string()),
		bccAddresses: v.array(v.string()),
		subject: v.string(),
		/**
		 * Ignored: the snippet is derived here from the bodies. Accepted for one
		 * release so an older IMAP server still validates; drop it after that.
		 */
		snippet: v.optional(v.string()),
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
		const snippet = buildSnippet(args.textBodyInline, args.htmlBodyInline);
		const uid = folder.uidNext;
		const modseq = folder.highestModseq + 1;

		const flagSet = new Set((args.flags ?? []).map((f) => f.toLowerCase()));
		const customFlags: string[] = [];
		for (const f of args.flags ?? []) {
			if (!isImapSystemFlag(f.toLowerCase())) customFlags.push(f);
		}

		// A client-sent reply's Sent copy (Thunderbird, Apple Mail, …) joins the
		// conversation it answers, through the same threading every delivered
		// message goes through; before, every APPEND opened its own thread, so the
		// user's reply never showed in the conversation and the correspondent's
		// next message (which references the reply) split off with it. Drafts
		// keep a thread of their own: clients re-APPEND them on every autosave.
		const normalizedSubject = normalizeSubject(args.subject);
		const references = args.references ?? [];
		const threadRootId = conversationRootId(args.rfc822MessageId, args.inReplyTo, references);
		const existingThreadId =
			folder.role === 'drafts'
				? null
				: await resolveDeliveryThread(ctx, {
						mailbox,
						messageId: args.rfc822MessageId,
						rootId: threadRootId,
						references: args.inReplyTo ? [args.inReplyTo, ...references] : references,
						subject: args.subject,
						normalizedSubject,
						receivedAt: internalDate,
						parties: [args.fromAddress, ...args.toAddresses, ...args.ccAddresses],
					});
		const threadId =
			existingThreadId ??
			(await ctx.db.insert('mailThreads', {
				mailboxId: folder.mailboxId,
				normalizedSubject,
				participants: mergeThreadParticipants([
					args.fromAddress,
					...args.toAddresses,
					...args.ccAddresses,
				]),
				messageCount: 1,
				unreadCount: flagSet.has('\\seen') ? 0 : 1,
				hasFlagged: flagSet.has('\\flagged'),
				hasAttachments: false,
				lastMessageAt: internalDate,
				firstMessageAt: internalDate,
				latestSnippet: snippet,
				latestFromAddress: args.fromAddress,
				latestSubject: args.subject,
				folderRoles: folder.role ? [folder.role] : [],
				labelIds: [],
				createdAt: now,
				updatedAt: now,
			}));

		const messageId = await ctx.db.insert('mailMessages', {
			mailboxId: folder.mailboxId,
			folderId: folder._id,
			uid,
			modseq,
			rfc822MessageId: args.rfc822MessageId,
			inReplyTo: args.inReplyTo,
			references: references.length > 0 ? references : undefined,
			// A draft sits outside the conversation, so it must not be the row a
			// later delivery finds by root.
			threadRootId: folder.role === 'drafts' ? undefined : threadRootId,
			threadId,
			fromAddress: args.fromAddress,
			fromName: args.fromName,
			toAddresses: args.toAddresses,
			ccAddresses: args.ccAddresses,
			bccAddresses: args.bccAddresses,
			subject: args.subject,
			normalizedSubject,
			snippet,
			// Deep body search (idea 32): an APPENDed message is a delivered message
			// as far as search is concerned, so it carries the same excerpt under the
			// same instance opt-in. Skipping it here would leave a hole the body index
			// cannot report — an IMAP-uploaded message findable only by its first 200
			// characters, on an instance that believes it searches whole bodies.
			searchBody: (await isBodySearchIndexingEnabled(ctx))
				? buildSearchBody(args.textBodyInline, args.htmlBodyInline) || undefined
				: undefined,
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

		if (existingThreadId) {
			// Counters, participants, folder roles and the latest pointers all move
			// with the new message; re-deriving them is simpler than patching each.
			await rebuildThreadAggregates(ctx, threadId);
			// Our reply sent from a desktop client settles the Reply Queue row, as
			// the same reply synced from a provider's Sent folder does.
			await clearNeedsReplyOnOwnerReply(ctx, messageId);
		} else {
			// The conversation list links to latestMessageId; set it now that the
			// appended message exists.
			// A just-appended message is never snoozed (plan C8).
			await ctx.db.patch(threadId, { latestMessageId: messageId, latestSnoozedUntil: null });
		}

		// E8b: the IMAP server uploads the raw `.eml` straight to storage
		// (plaintext), so seal it at rest out-of-band — a mutation can't read/re-store
		// a blob's bytes. Idempotent + resumable; the accessor + `/sealed-blob` proxy
		// serve it correctly in the meantime (mixed-state tolerance).
		await ctx.scheduler.runAfter(0, internal.mail.blobReseal.resealMessageBlobs, { id: messageId });

		await ctx.db.patch(folder._id, {
			uidNext: uid + 1,
			highestModseq: modseq,
			totalCount: folder.totalCount + 1,
			unseenCount: folder.unseenCount + (flagSet.has('\\seen') ? 0 : 1),
			updatedAt: now,
		});
		await applyMailboxUsageDelta(ctx, mailbox, args.rawSize, now);

		return {
			messageId,
			uid,
			uidValidity: folder.uidValidity,
			modseq,
		};
	},
});
