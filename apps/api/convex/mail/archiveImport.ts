/**
 * Upload-based archive import (idea 50) — the job surface.
 *
 * `migration.ts` next door imports a mailbox we can log into. This imports one
 * the user only has a FILE of: a Gmail Takeout `.mbox`, a `.eml` saved out of a
 * dead client, an archive from a provider that shut down. The wizard uploads
 * the bytes to Convex storage (`api.storage.generateUploadUrl`), calls
 * {@link start}, and then watches {@link getStatus} — the same three-call shape
 * the IMAP migration already has.
 *
 * Split across two files for the ~500 LOC ratchet:
 *   - here: the job row's lifecycle (start / status / cancel) plus the internal
 *     mutations the runner commits through;
 *   - `archiveImportRun.ts`: the action that parses and inserts, budgets itself,
 *     and reschedules until the archive is consumed.
 *
 * Every insert goes through `insertDeliveredMessage`, the same shared path the
 * hosted MX inbound and the IMAP backfill use, so imported mail threads, gets a
 * UID, counts toward the folder aggregates and is indexed exactly like mail that
 * arrived normally.
 */

import { v } from 'convex/values';
import { routeGmailLabels, parseGmailLabelsHeader } from '@owlat/shared/gmailTakeout';
import { internalMutation, internalQuery, type MutationCtx } from '../_generated/server';
import { authedMutation, publicQuery } from '../lib/authedFunctions';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { throwForbidden } from '../_utils/errors';
import { requireMailboxAccess } from './permissions';
import { insertDeliveredMessage } from './deliveryPipeline/insert';
import { mailMessageAttachmentValidator } from '../lib/convexValidators';
import { resolveLabelPath } from './labels';

/**
 * Largest archive one job accepts.
 *
 * The runner re-reads the uploaded blob on every run (that is what makes a
 * resumed run cheap to reason about — it seeks to a byte offset rather than
 * carrying state across action lifetimes), so the ceiling is really "how much
 * an action can hold at once". 64 MiB leaves generous headroom and still covers
 * a typical multi-year Takeout of a personal mailbox; a bigger archive splits
 * into several uploads, which Takeout itself already does.
 */
export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

const archiveFormatValidator = v.union(v.literal('mbox'), v.literal('eml'));

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

/** The caller-visible shape of a job row (the wizard's progress readout). */
function toStatus(job: Doc<'mailArchiveImports'>) {
	return {
		_id: job._id,
		status: job.status,
		filename: job.filename,
		format: job.format,
		totalBytes: job.totalBytes,
		cursorBytes: job.cursorBytes,
		messagesImported: job.messagesImported,
		messagesSkipped: job.messagesSkipped,
		labelsCreated: job.labelsCreated,
		// Bytes consumed, not messages: an archive's message count is unknown
		// until it has been read, and a bar that jumps when the denominator is
		// discovered is worse than one that tracks the file.
		percent:
			job.status === 'importing'
				? job.totalBytes > 0
					? Math.min(100, Math.round((job.cursorBytes / job.totalBytes) * 100))
					: 0
				: 100,
		lastError: job.lastError,
		startedAt: job.startedAt,
		completedAt: job.completedAt,
	};
}

// ============================================================
// Public surface (the migration wizard)
// ============================================================

/**
 * The caller's most recent archive import for one mailbox, or `null`.
 * Soft-auth: an anonymous caller and a caller without access both get `null`.
 */
// public: soft-auth — returns null for anonymous; mailbox access is enforced in-handler
export const getStatus = publicQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args) => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId);
		if (!owned.ok) return null;
		const job = await ctx.db
			.query('mailArchiveImports')
			.withIndex('by_mailbox', (q) => q.eq('mailboxId', args.mailboxId))
			.order('desc')
			.first();
		return job ? toStatus(job) : null;
	},
});

/**
 * Begin importing an uploaded archive into the caller's mailbox.
 *
 * Refuses a second concurrent job for the same mailbox rather than queueing:
 * two runners walking two archives into one mailbox would race on the folder
 * UID allocation, and "wait for the current import" is a truthful thing to say.
 *
 * A refusal RETURNS rather than throws, because it also has to delete the
 * upload: a thrown mutation rolls its whole transaction back, storage delete
 * included, so throwing here would leave exactly the orphaned bytes the check
 * exists to avoid. The wizard renders `reason` as its own message.
 */
// authz: self — requireMailboxAccess gates the target mailbox before anything is inserted
export const start = authedMutation({
	args: {
		mailboxId: v.id('mailboxes'),
		storageId: v.id('_storage'),
		filename: v.string(),
		format: archiveFormatValidator,
		totalBytes: v.number(),
	},
	handler: async (
		ctx,
		args
	): Promise<
		| { ok: true; importId: Id<'mailArchiveImports'> }
		| { ok: false; reason: 'empty' | 'too_large' | 'already_running' | 'mailbox_inactive' }
	> => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId);
		// The one throwing branch: an upload aimed at someone else's mailbox is
		// not a refusal to render, and its bytes are not ours to delete on the
		// word of a caller who has no access to the target.
		if (!owned.ok) throwForbidden('Mailbox not accessible');

		const refuse = async (
			reason: 'empty' | 'too_large' | 'already_running' | 'mailbox_inactive'
		) => {
			await ctx.storage.delete(args.storageId).catch(() => undefined);
			return { ok: false as const, reason };
		};
		if (owned.mailbox.status !== 'active') return await refuse('mailbox_inactive');
		if (args.totalBytes <= 0) return await refuse('empty');
		if (args.totalBytes > MAX_ARCHIVE_BYTES) return await refuse('too_large');

		const running = await ctx.db
			.query('mailArchiveImports')
			.withIndex('by_mailbox', (q) => q.eq('mailboxId', args.mailboxId))
			.order('desc')
			.first();
		if (running?.status === 'importing') return await refuse('already_running');

		const now = Date.now();
		const importId = await ctx.db.insert('mailArchiveImports', {
			userId: owned.userId,
			mailboxId: args.mailboxId,
			storageId: args.storageId,
			filename: args.filename.slice(0, 200),
			format: args.format,
			totalBytes: args.totalBytes,
			cursorBytes: 0,
			messagesImported: 0,
			messagesSkipped: 0,
			labelsCreated: 0,
			status: 'importing',
			startedAt: now,
			updatedAt: now,
		});
		await ctx.db.insert('mailAuditLog', {
			mailboxId: args.mailboxId,
			event: 'archive_import.started',
			details: `format=${args.format} bytes=${args.totalBytes}`,
			occurredAt: now,
		});
		await ctx.scheduler.runAfter(0, internal.mail.archiveImportRun.runChunk, { importId });
		return { ok: true, importId };
	},
});

/**
 * Stop an import. Already-imported messages stay — they are real mail now, and
 * a half-finished import is a smaller mailbox, not a broken one. The next
 * runner pass sees the non-importing status and exits at its batch boundary.
 */
// authz: self — the job is resolved through its mailbox, which requireMailboxAccess gates
export const cancel = authedMutation({
	args: { importId: v.id('mailArchiveImports') },
	handler: async (ctx, args): Promise<boolean> => {
		const job = await ctx.db.get(args.importId);
		if (!job) return false;
		const owned = await requireMailboxAccess(ctx, job.mailboxId);
		if (!owned.ok) throwForbidden('Mailbox not accessible');
		if (job.status !== 'importing') return false;
		await finalizeJob(ctx, job, 'cancelled');
		return true;
	},
});

// ============================================================
// Internal surface — the runner (archiveImportRun.ts)
// ============================================================

/** Delete the uploaded archive and mark the job terminal. */
async function finalizeJob(
	ctx: MutationCtx,
	job: Doc<'mailArchiveImports'>,
	status: 'completed' | 'failed' | 'cancelled',
	lastError?: string
): Promise<void> {
	const now = Date.now();
	if (job.storageId) {
		// The imported messages are the artifact; the upload is scratch space.
		await ctx.storage.delete(job.storageId).catch(() => undefined);
	}
	await ctx.db.patch(job._id, {
		status,
		storageId: undefined,
		completedAt: now,
		updatedAt: now,
		...(lastError ? { lastError: lastError.slice(0, 500) } : {}),
	});
	await ctx.db.insert('mailAuditLog', {
		mailboxId: job.mailboxId,
		event: `archive_import.${status}`,
		details: `imported=${job.messagesImported} skipped=${job.messagesSkipped}`,
		occurredAt: now,
	});
}

export const loadJob = internalQuery({
	args: { importId: v.id('mailArchiveImports') },
	handler: async (ctx, args): Promise<Doc<'mailArchiveImports'> | null> =>
		await ctx.db.get(args.importId),
});

/**
 * Commit one batch: advance the resume offset and add the batch's counters.
 * Returns whether the job is still importing, so the runner stops promptly at a
 * batch boundary when the user cancelled mid-archive.
 */
export const recordProgress = internalMutation({
	args: {
		importId: v.id('mailArchiveImports'),
		cursorBytes: v.number(),
		importedDelta: v.number(),
		skippedDelta: v.number(),
		labelsCreatedDelta: v.number(),
	},
	handler: async (ctx, args): Promise<{ stillImporting: boolean }> => {
		const job = await ctx.db.get(args.importId);
		if (!job || job.status !== 'importing') return { stillImporting: false };
		await ctx.db.patch(job._id, {
			// Never rewind: a retried run re-reads bytes it already committed, and
			// the counters above are the only thing that must not double-count.
			cursorBytes: Math.max(job.cursorBytes, args.cursorBytes),
			messagesImported: job.messagesImported + args.importedDelta,
			messagesSkipped: job.messagesSkipped + args.skippedDelta,
			labelsCreated: job.labelsCreated + args.labelsCreatedDelta,
			updatedAt: Date.now(),
		});
		return { stillImporting: true };
	},
});

/** The archive is consumed (or the runner gave up). Close the job. */
export const finishJob = internalMutation({
	args: {
		importId: v.id('mailArchiveImports'),
		status: v.union(v.literal('completed'), v.literal('failed')),
		lastError: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const job = await ctx.db.get(args.importId);
		if (!job || job.status !== 'importing') return;
		await finalizeJob(ctx, job, args.status, args.lastError);
	},
});

/**
 * Insert one parsed archive message.
 *
 * Deduped on Message-ID within the mailbox, so re-importing an archive (or
 * re-reading the bytes after a failed run) adds nothing twice. Gmail Takeout's
 * `X-Gmail-Labels` decides the folder, the read/star flags and the labels —
 * see `@owlat/shared/gmailTakeout`; an archive without that header lands
 * wherever the caller's `folderRole` says.
 */
export const ingestArchiveMessage = internalMutation({
	args: {
		importId: v.id('mailArchiveImports'),
		folderRole: folderRoleValidator,
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
		searchBody: v.optional(v.string()),
		messageId: v.string(),
		inReplyTo: v.optional(v.string()),
		references: v.optional(v.string()),
		receivedAt: v.number(),
		attachments: v.array(mailMessageAttachmentValidator),
		/** Raw `X-Gmail-Labels` value, when the archive carries one. */
		gmailLabels: v.optional(v.string()),
	},
	handler: async (
		ctx,
		args
	): Promise<{ imported: boolean; skipped: boolean; labelsCreated: number }> => {
		const dropBlobs = async () => {
			await ctx.storage.delete(args.rawStorageId).catch(() => undefined);
			if (args.textBodyStorageId) {
				await ctx.storage.delete(args.textBodyStorageId).catch(() => undefined);
			}
			if (args.htmlBodyStorageId) {
				await ctx.storage.delete(args.htmlBodyStorageId).catch(() => undefined);
			}
		};
		const skip = async () => {
			await dropBlobs();
			return { imported: false, skipped: true, labelsCreated: 0 };
		};

		const job = await ctx.db.get(args.importId);
		if (!job || job.status !== 'importing') return await skip();
		const mailbox = await ctx.db.get(job.mailboxId);
		if (!mailbox || mailbox.status !== 'active') return await skip();

		const rfc822MessageId = canonicalMessageId(args.messageId);
		const duplicate = await ctx.db
			.query('mailMessages')
			.withIndex('by_rfc822_message_id', (q) => q.eq('rfc822MessageId', rfc822MessageId))
			.filter((q) => q.eq(q.field('mailboxId'), mailbox._id))
			.first();
		if (duplicate) return await skip();

		// Gmail's own labels outrank the caller's guess: the header is the only
		// record of where the message actually lived.
		const routing = args.gmailLabels
			? routeGmailLabels(parseGmailLabelsHeader(args.gmailLabels))
			: null;
		const folderRole = routing?.folderRole ?? args.folderRole;
		const folder = await ctx.db
			.query('mailFolders')
			.withIndex('by_mailbox_and_role', (q) =>
				q.eq('mailboxId', mailbox._id).eq('role', folderRole)
			)
			.first();
		if (!folder) return await skip();

		let labelsCreated = 0;
		const labelIds: Id<'mailLabels'>[] = [];
		for (const name of routing?.labelNames ?? []) {
			const resolved = await resolveLabelPath(ctx, mailbox._id, name);
			if (!resolved) continue;
			labelsCreated += resolved.created;
			labelIds.push(resolved.labelId);
		}

		await insertDeliveredMessage(ctx, {
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
			searchBody: args.searchBody,
			messageId: rfc822MessageId,
			inReplyTo: args.inReplyTo,
			references: args.references,
			receivedAt: args.receivedAt,
			attachments: args.attachments,
			// Gmail records UNREAD, so an archive without the header is read mail:
			// an import must never manufacture thousands of unread messages.
			flagSeen: routing?.flagSeen ?? true,
			flagFlagged: routing?.flagFlagged ?? false,
			...(labelIds.length > 0 ? { labelIds } : {}),
			countUsedBytes: true,
		});
		return { imported: true, skipped: false, labelsCreated };
	},
});
