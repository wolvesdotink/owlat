/**
 * Resumable backfill of the `mailAttachments` index over EXISTING mail.
 *
 * The write path (`mail/attachmentIndex.ts`) only ever sees mail delivered
 * after the index shipped. Without this walk, the Files view and `filename:`
 * would cover "everything since the deploy", which for the question they exist
 * to answer ("where is that contract PDF?") is the wrong half of the mailbox.
 *
 * Shape: one job row per mailbox, a cursor-paginated `mailMessages` scan that
 * reschedules itself one bounded page at a time (the same self-rescheduling
 * continuation as `mail/labels.stripLabelReferences`), with the row on top so
 * the UI can show progress and cancel mid-walk. Idempotent — a message that
 * already has junction rows is skipped by `indexMessageAttachments`, so a
 * restarted or overlapping walk can never double a file.
 */

import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { authedMutation, publicQuery } from '../lib/authedFunctions';
import { internal } from '../_generated/api';
import { requireMailboxAccess } from './permissions';
import { throwForbidden } from '../_utils/errors';
import { indexMessageAttachments, indexableFromMessage } from './attachmentIndex';

/**
 * Messages read per transaction. Deliberately smaller than the label-cleanup
 * batch: each row here can write several junction rows, so the write budget,
 * not the read budget, is the binding constraint.
 */
export const ATTACHMENT_BACKFILL_BATCH = 128;

/**
 * The current backfill job for a mailbox, or null. Drives the Files view's
 * progress strip; absent means "never run here", which is the state every
 * mailbox starts in.
 */
// public: soft-auth — returns null for anonymous; mailbox access is still enforced in-handler
export const status = publicQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args) => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId);
		if (!owned.ok) return null;
		return ctx.db
			.query('mailAttachmentBackfillJobs')
			.withIndex('by_mailbox', (q) => q.eq('mailboxId', args.mailboxId))
			.first();
	},
});

/**
 * Start (or restart) the walk for one mailbox. Owner-grade: the index it
 * populates is mailbox-wide and the walk costs a whole-mailbox scan, so it is
 * not something a shared-inbox member should be able to kick off.
 *
 * Re-entrant by design — a job already `running` is left alone rather than
 * forked, so a double click cannot produce two walks racing over one cursor.
 */
export const start = authedMutation({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args): Promise<{ started: boolean }> => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId, 'owner');
		if (!owned.ok) throwForbidden('Mailbox not accessible');

		const existing = await ctx.db
			.query('mailAttachmentBackfillJobs')
			.withIndex('by_mailbox', (q) => q.eq('mailboxId', args.mailboxId))
			.first();
		if (existing?.status === 'running') return { started: false };

		const now = Date.now();
		if (existing) {
			await ctx.db.patch(existing._id, {
				status: 'running',
				cursor: undefined,
				scannedCount: 0,
				indexedCount: 0,
				startedAt: now,
				updatedAt: now,
				finishedAt: undefined,
				errorMessage: undefined,
			});
		} else {
			await ctx.db.insert('mailAttachmentBackfillJobs', {
				mailboxId: args.mailboxId,
				status: 'running',
				scannedCount: 0,
				indexedCount: 0,
				startedAt: now,
				updatedAt: now,
			});
		}
		await ctx.scheduler.runAfter(0, internal.mail.attachmentBackfill.runBatch, {
			mailboxId: args.mailboxId,
		});
		return { started: true };
	},
});

/**
 * Stop a running walk. The index keeps every row written so far — a cancelled
 * backfill is a partial index, never a corrupt one, and restarting resumes from
 * the beginning without duplicating what is already there.
 */
export const cancel = authedMutation({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args): Promise<void> => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId, 'owner');
		if (!owned.ok) throwForbidden('Mailbox not accessible');
		const job = await ctx.db
			.query('mailAttachmentBackfillJobs')
			.withIndex('by_mailbox', (q) => q.eq('mailboxId', args.mailboxId))
			.first();
		if (!job || job.status !== 'running') return;
		const now = Date.now();
		await ctx.db.patch(job._id, { status: 'cancelled', updatedAt: now, finishedAt: now });
	},
});

/**
 * One page of the walk, then reschedule. The job row is re-read every batch so
 * a `cancel` between pages actually stops it, rather than being overwritten by
 * an in-flight continuation.
 */
export const runBatch = internalMutation({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args): Promise<void> => {
		const job = await ctx.db
			.query('mailAttachmentBackfillJobs')
			.withIndex('by_mailbox', (q) => q.eq('mailboxId', args.mailboxId))
			.first();
		if (!job || job.status !== 'running') return;

		const { page, isDone, continueCursor } = await ctx.db
			.query('mailMessages')
			.withIndex('by_mailbox_and_received', (q) => q.eq('mailboxId', args.mailboxId))
			.paginate({ cursor: job.cursor ?? null, numItems: ATTACHMENT_BACKFILL_BATCH });

		let indexed = 0;
		for (const message of page) {
			if (!message.hasAttachments) continue;
			indexed += await indexMessageAttachments(ctx, indexableFromMessage(message));
		}

		const now = Date.now();
		await ctx.db.patch(job._id, {
			cursor: isDone ? undefined : continueCursor,
			scannedCount: job.scannedCount + page.length,
			indexedCount: job.indexedCount + indexed,
			status: isDone ? 'completed' : 'running',
			updatedAt: now,
			...(isDone ? { finishedAt: now } : {}),
		});
		if (!isDone) {
			await ctx.scheduler.runAfter(0, internal.mail.attachmentBackfill.runBatch, {
				mailboxId: args.mailboxId,
			});
		}
	},
});
