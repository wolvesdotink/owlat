/**
 * External IMAP-sync delivery — the worker-facing inbound surface.
 *
 * The apps/mail-sync worker fetches messages over IMAP from a user's external
 * mailbox, uploads the raw RFC822 to Convex storage, and calls
 * `ingestExternalMessage` to land each one. Unlike the hosted MX path
 * (`delivery.deliverToMailbox`, which resolves the mailbox by recipient address
 * and routes via filters/spam verdict), here the worker already knows the
 * target account + folder role, so we insert directly into the mapped folder.
 *
 * Shared insert/threading logic is reused via `insertDeliveredMessage`.
 * These are all internal functions — the worker calls them with the admin key.
 */

import { v } from 'convex/values';
import { mailMessageAttachmentValidator, mailUnsubscribeValidator } from '../lib/convexValidators';
import {
	internalAction,
	internalMutation,
	internalQuery,
	type MutationCtx,
} from '../_generated/server';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { insertDeliveredMessage, splitBodyForStorage, buildSnippet } from './delivery';
import { storeSealedBlob } from '../lib/sealedBlob';
import { extractListUnsubscribe } from '@owlat/shared/listUnsubscribe';

const folderRoleValidator = v.union(
	v.literal('inbox'),
	v.literal('sent'),
	v.literal('drafts'),
	v.literal('trash'),
	v.literal('spam'),
	v.literal('archive')
);

/** Strip RFC 5322 angle brackets from a Message-ID for dedup. */
function canonicalMessageId(raw: string): string {
	return raw.replace(/[<>]/g, '').trim() || raw;
}

/**
 * Ingest one synced message into its mapped local folder, dedup on Message-ID,
 * and advance the per-folder sync cursor. The worker has already uploaded the
 * raw bytes to `rawStorageId`. On skip (account gone / mailbox inactive / dup /
 * folder missing) the staged blob is deleted to avoid orphans.
 */
export const ingestExternalMessage = internalMutation({
	args: {
		accountId: v.id('externalMailAccounts'),
		folderRole: folderRoleValidator,
		remoteName: v.string(),
		remoteUid: v.number(),
		remoteUidValidity: v.number(),
		rawStorageId: v.id('_storage'),
		rawSize: v.number(),
		from: v.string(),
		to: v.array(v.string()),
		cc: v.array(v.string()),
		bcc: v.array(v.string()),
		replyTo: v.optional(v.string()),
		subject: v.string(),
		textBodyInline: v.optional(v.string()),
		textBodyStorageId: v.optional(v.id('_storage')),
		htmlBodyInline: v.optional(v.string()),
		htmlBodyStorageId: v.optional(v.id('_storage')),
		snippet: v.optional(v.string()),
		messageId: v.string(),
		inReplyTo: v.optional(v.string()),
		references: v.optional(v.string()),
		receivedAt: v.number(),
		attachments: v.array(mailMessageAttachmentValidator),
		flagSeen: v.optional(v.boolean()),
		flagFlagged: v.optional(v.boolean()),
		// Parsed List-Unsubscribe target (extracted at ingest by ingestExternalRaw).
		unsubscribe: v.optional(mailUnsubscribeValidator),
	},
	handler: async (ctx, args): Promise<{ messageId: Id<'mailMessages'> } | { skipped: true }> => {
		const dropBlob = async () => {
			await ctx.storage.delete(args.rawStorageId).catch(() => undefined);
			if (args.textBodyStorageId) {
				await ctx.storage.delete(args.textBodyStorageId).catch(() => undefined);
			}
			if (args.htmlBodyStorageId) {
				await ctx.storage.delete(args.htmlBodyStorageId).catch(() => undefined);
			}
		};

		const account = await ctx.db.get(args.accountId);
		if (!account || account.status === 'disconnected') {
			await dropBlob();
			return { skipped: true };
		}
		const mailbox = await ctx.db.get(account.mailboxId);
		if (!mailbox || mailbox.status !== 'active') {
			await dropBlob();
			return { skipped: true };
		}

		// Dedup on Message-ID within this mailbox. This also catches the Sent
		// copy the worker APPENDs after an outbound send (same Message-ID as the
		// lifecycle-inserted Sent row), so we don't double-insert.
		const rfc822MessageId = canonicalMessageId(args.messageId);
		const dup = await ctx.db
			.query('mailMessages')
			.withIndex('by_rfc822_message_id', (q) => q.eq('rfc822MessageId', rfc822MessageId))
			.filter((q) => q.eq(q.field('mailboxId'), mailbox._id))
			.first();
		if (dup) {
			await dropBlob();
			await advanceCursor(ctx, args, mailbox._id);
			return { skipped: true };
		}

		const folder = await ctx.db
			.query('mailFolders')
			.withIndex('by_mailbox_and_role', (q) =>
				q.eq('mailboxId', mailbox._id).eq('role', args.folderRole)
			)
			.first();
		if (!folder) {
			await dropBlob();
			return { skipped: true };
		}

		const messageId = await insertDeliveredMessage(ctx, {
			mailbox,
			folder,
			rawStorageId: args.rawStorageId,
			rawSize: args.rawSize,
			from: args.from,
			to: args.to,
			cc: args.cc,
			bcc: args.bcc,
			replyTo: args.replyTo,
			subject: args.subject,
			textBodyInline: args.textBodyInline,
			textBodyStorageId: args.textBodyStorageId,
			htmlBodyInline: args.htmlBodyInline,
			htmlBodyStorageId: args.htmlBodyStorageId,
			snippet: args.snippet,
			messageId: args.messageId,
			inReplyTo: args.inReplyTo,
			references: args.references,
			receivedAt: args.receivedAt,
			attachments: args.attachments,
			flagSeen: args.flagSeen,
			flagFlagged: args.flagFlagged,
			unsubscribe: args.unsubscribe,
			// Remote provider already filtered spam/virus; no verdict fields.
			countUsedBytes: true,
		});

		await advanceCursor(ctx, args, mailbox._id);
		await ctx.db.patch(args.accountId, { lastSyncAt: Date.now(), updatedAt: Date.now() });
		return { messageId };
	},
});

/** Upsert the (account, remoteName) cursor, advancing lastSeenUid monotonically. */
async function advanceCursor(
	ctx: MutationCtx,
	args: {
		accountId: Id<'externalMailAccounts'>;
		remoteName: string;
		remoteUid: number;
		remoteUidValidity: number;
	},
	mailboxId: Id<'mailboxes'>
): Promise<void> {
	const now = Date.now();
	const existing = await ctx.db
		.query('externalMailFolderSync')
		.withIndex('by_account_and_remote', (q) =>
			q.eq('accountId', args.accountId).eq('remoteName', args.remoteName)
		)
		.first();
	if (existing) {
		await ctx.db.patch(existing._id, {
			lastSeenUid: Math.max(existing.lastSeenUid, args.remoteUid),
			remoteUidValidity: args.remoteUidValidity,
			lastSyncedAt: now,
		});
		return;
	}
	// No mapping row yet (worker ingesting before discovery recorded it) — find
	// the local folder so the cursor row is complete.
	const folder = await ctx.db
		.query('mailFolders')
		.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailboxId))
		.first();
	if (!folder) return;
	await ctx.db.insert('externalMailFolderSync', {
		accountId: args.accountId,
		mailboxId,
		folderId: folder._id,
		remoteName: args.remoteName,
		remoteUidValidity: args.remoteUidValidity,
		lastSeenUid: args.remoteUid,
		lastSyncedAt: now,
	});
}

/**
 * Folder cursors for an account, so the worker resumes incremental fetch from
 * `lastSeenUid + 1` on (re)connect. Internal/admin-key only.
 */
export const getSyncState = internalQuery({
	args: { accountId: v.id('externalMailAccounts') },
	handler: async (ctx, args) => {
		const rows = await ctx.db
			.query('externalMailFolderSync')
			.withIndex('by_account', (q) => q.eq('accountId', args.accountId))
			.collect(); // bounded: per-account folder cursors (≤ a handful)
		return rows.map((r) => ({
			remoteName: r.remoteName,
			remoteUidValidity: r.remoteUidValidity,
			lastSeenUid: r.lastSeenUid,
			folderId: r.folderId,
		}));
	},
});

/**
 * Record a remote→local folder mapping during the worker's folder discovery.
 * Sets the initial high-water UID so v1 only syncs NEW mail going forward
 * (no historical backfill). If the remote UIDVALIDITY changed since last seen,
 * reset the cursor to the new high-water mark.
 */
export const recordFolderMapping = internalMutation({
	args: {
		accountId: v.id('externalMailAccounts'),
		folderRole: folderRoleValidator,
		remoteName: v.string(),
		remoteUidValidity: v.number(),
		initialLastSeenUid: v.number(),
	},
	handler: async (ctx, args) => {
		const account = await ctx.db.get(args.accountId);
		if (!account) return;
		const folder = await ctx.db
			.query('mailFolders')
			.withIndex('by_mailbox_and_role', (q) =>
				q.eq('mailboxId', account.mailboxId).eq('role', args.folderRole)
			)
			.first();
		if (!folder) return;
		const now = Date.now();
		const existing = await ctx.db
			.query('externalMailFolderSync')
			.withIndex('by_account_and_remote', (q) =>
				q.eq('accountId', args.accountId).eq('remoteName', args.remoteName)
			)
			.first();
		if (existing) {
			if (existing.remoteUidValidity !== args.remoteUidValidity) {
				// Remote renumbered everything — reset to the new high-water mark.
				await ctx.db.patch(existing._id, {
					remoteUidValidity: args.remoteUidValidity,
					lastSeenUid: args.initialLastSeenUid,
					lastSyncedAt: now,
				});
			}
			return;
		}
		await ctx.db.insert('externalMailFolderSync', {
			accountId: args.accountId,
			mailboxId: account.mailboxId,
			folderId: folder._id,
			remoteName: args.remoteName,
			remoteUidValidity: args.remoteUidValidity,
			lastSeenUid: args.initialLastSeenUid,
			lastSyncedAt: now,
		});
	},
});

/**
 * Raw-bytes ingestion entry point for the mail-sync worker. The worker can't
 * generate a Convex upload URL (that needs a user session; the worker holds
 * the admin key), so — mirroring `delivery.ingestFromWebhook` — it passes the
 * raw RFC822 as base64 to this action, which stores the blob and delegates to
 * the `ingestExternalMessage` mutation.
 */
export const ingestExternalRaw = internalAction({
	args: {
		accountId: v.id('externalMailAccounts'),
		folderRole: folderRoleValidator,
		remoteName: v.string(),
		remoteUid: v.number(),
		remoteUidValidity: v.number(),
		rawBytesBase64: v.string(),
		from: v.string(),
		to: v.array(v.string()),
		cc: v.array(v.string()),
		bcc: v.array(v.string()),
		replyTo: v.optional(v.string()),
		subject: v.string(),
		textBodyInline: v.optional(v.string()),
		htmlBodyInline: v.optional(v.string()),
		messageId: v.string(),
		inReplyTo: v.optional(v.string()),
		references: v.optional(v.string()),
		receivedAt: v.number(),
		attachments: v.array(mailMessageAttachmentValidator),
		flagSeen: v.optional(v.boolean()),
		flagFlagged: v.optional(v.boolean()),
	},
	handler: async (ctx, args): Promise<{ messageId: Id<'mailMessages'> } | { skipped: true }> => {
		const rawBytes = Buffer.from(args.rawBytesBase64, 'base64');
		// E8b: seal the raw `.eml` at rest (byte cipher); the reader path + the
		// `/sealed-blob` proxy unseal it for the web reader / IMAP bridge.
		const rawStorageId = await storeSealedBlob(ctx.storage, rawBytes, 'message/rfc822');
		// Bodies arrive uncapped from the worker; inline small ones, stash large
		// ones as blobs (served lazily by mailbox.getMessageBody).
		const textBody = await splitBodyForStorage(
			ctx,
			args.textBodyInline,
			'text/plain; charset=utf-8'
		);
		const htmlBody = await splitBodyForStorage(
			ctx,
			args.htmlBodyInline,
			'text/html; charset=utf-8'
		);
		const snippet = buildSnippet(args.textBodyInline, args.htmlBodyInline);
		// List-Unsubscribe / List-Unsubscribe-Post (RFC 2369 / 8058), parsed once
		// at ingest so the reader's Unsubscribe chip never re-opens the raw .eml.
		const unsubscribe =
			extractListUnsubscribe(rawBytes.subarray(0, 65536).toString('utf8')) ?? undefined;
		// `ingestExternalMessage` deletes the staged blobs itself on skip/dup.
		return await ctx.runMutation(internal.mail.externalDelivery.ingestExternalMessage, {
			accountId: args.accountId,
			folderRole: args.folderRole,
			remoteName: args.remoteName,
			remoteUid: args.remoteUid,
			remoteUidValidity: args.remoteUidValidity,
			rawStorageId,
			rawSize: rawBytes.length,
			from: args.from,
			to: args.to,
			cc: args.cc,
			bcc: args.bcc,
			replyTo: args.replyTo,
			subject: args.subject,
			textBodyInline: textBody.inline,
			textBodyStorageId: textBody.storageId,
			htmlBodyInline: htmlBody.inline,
			htmlBodyStorageId: htmlBody.storageId,
			snippet,
			messageId: args.messageId,
			inReplyTo: args.inReplyTo,
			references: args.references,
			receivedAt: args.receivedAt,
			attachments: args.attachments,
			flagSeen: args.flagSeen,
			flagFlagged: args.flagFlagged,
			unsubscribe,
		});
	},
});
