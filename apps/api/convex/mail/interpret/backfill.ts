/**
 * The thread brief's backfill (ADR-0072, D5): interpret a mailbox's active
 * threads of the last 30 days, so the Overview, the list rows and the To-do
 * band are there for mail that arrived before the brief did. Older threads
 * are interpreted on first open instead (`lazy.ts`).
 *
 * Shaped like the attachment and body-search backfills: one job row per
 * mailbox (`interpretBackfillJobs`), started and cancelled by the mailbox
 * owner, and a self-rescheduling `runBatch` that pages the mailbox's threads
 * newest first down to the cutoff. Each batch hands at most
 * {@link THREADS_PER_BATCH} threads to `enqueueThreadInterpretation`
 * (`backfillSources.ts`, which never notifies and never touches the Reply
 * Queue), then waits {@link BATCH_INTERVAL_MS} so the runs it scheduled are
 * billed before the next batch asks the spend gate again.
 *
 * Bounded and budgeted:
 *   - every batch first asks the interpretation gate (`gate.ts`: the `ai`
 *     flag and the advisory spend reserve). A refusal pauses the walk with its
 *     reason, cursor kept;
 *   - one run hands at most {@link MAX_THREADS_PER_RUN} threads over, then
 *     pauses (`run_cap`). Starting again resumes from the cursor.
 *
 * Resumable: `start` on a paused or cancelled walk continues from its cursor
 * and keeps its cutoff; on a completed one (or with `restart`) it begins a new
 * walk with a new cutoff. Pages are idempotent, because a message that already
 * has an interpretation snapshot is skipped.
 *
 * `startAll` is the operator's way to start every mailbox's walk after the
 * release that introduces the brief (`npx convex run`).
 */

import { v } from 'convex/values';
import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import { internalMutation } from '../../lib/writeFence';
import { publicQuery } from '../../lib/authedFunctions';
import { throwForbidden } from '../../_utils/errors';
import { postboxMutation } from '../_helpers';
import { requireMailboxAccess } from '../permissions';
import { modeOfMailbox } from './briefTop';
import { interpretGate } from './gate';
import { enqueueThreadInterpretation, isActiveThread, RUN_SPACING_MS } from './backfillSources';

/** How far back the walk reaches (D5). */
export const BACKFILL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** Threads read per batch. */
export const THREADS_PER_BATCH = 10;
/** Threads handed to interpretation per run before the walk pauses. */
export const MAX_THREADS_PER_RUN = 300;
/** Pause between batches, so the previous batch's spend is on the ledger. */
export const BATCH_INTERVAL_MS = 60_000;

type Job = Doc<'interpretBackfillJobs'>;

function readJob(ctx: Pick<QueryCtx, 'db'>, mailboxId: Id<'mailboxes'>): Promise<Job | null> {
	return ctx.db
		.query('interpretBackfillJobs')
		.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailboxId))
		.first();
}

/**
 * Start, resume or restart the mailbox's walk. A running walk is left alone.
 * Returns whether a walk is now running.
 */
export async function startBackfill(
	ctx: MutationCtx,
	mailboxId: Id<'mailboxes'>,
	opts: { restart?: boolean } = {}
): Promise<{ started: boolean }> {
	const existing = await readJob(ctx, mailboxId);
	if (existing?.status === 'running') return { started: false };
	const now = Date.now();
	const isResume =
		existing !== null &&
		!opts.restart &&
		existing.status !== 'completed' &&
		existing.cursor !== undefined;
	const fresh = {
		cutoffAt: now - BACKFILL_WINDOW_MS,
		cursor: undefined,
		scannedCount: 0,
		threadCount: 0,
		messageCount: 0,
	};
	const running = {
		status: 'running' as const,
		pausedReason: undefined,
		runThreadCount: 0,
		updatedAt: now,
		finishedAt: undefined,
	};
	if (existing) {
		await ctx.db.patch(existing._id, {
			...(isResume ? {} : { ...fresh, startedAt: now }),
			...running,
		});
	} else {
		await ctx.db.insert('interpretBackfillJobs', {
			mailboxId,
			...fresh,
			...running,
			startedAt: now,
		});
	}
	await ctx.scheduler.runAfter(0, internal.mail.interpret.backfill.runBatch, { mailboxId });
	return { started: true };
}

// public: soft-auth — returns null for anonymous; mailbox access is enforced in-handler
export const status = publicQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args) => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId);
		if (!owned.ok) return null;
		const job = await readJob(ctx, args.mailboxId);
		if (!job) return null;
		return {
			status: job.status,
			...(job.pausedReason ? { pausedReason: job.pausedReason } : {}),
			cutoffAt: job.cutoffAt,
			scannedCount: job.scannedCount,
			threadCount: job.threadCount,
			messageCount: job.messageCount,
			startedAt: job.startedAt,
			updatedAt: job.updatedAt,
			...(job.finishedAt !== undefined ? { finishedAt: job.finishedAt } : {}),
		};
	},
});

/**
 * Start (or resume) the walk. Owner-grade, like the other mailbox walks: it
 * spends the instance's AI budget on the whole mailbox.
 */
export const start = postboxMutation({
	args: { mailboxId: v.id('mailboxes'), restart: v.optional(v.boolean()) },
	handler: async (ctx, args, session): Promise<{ started: boolean }> => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId, 'owner', session);
		if (!owned.ok) throwForbidden('Mailbox not accessible');
		return startBackfill(ctx, args.mailboxId, { restart: args.restart });
	},
});

/** Stop a running walk; what it handed over stays, and start resumes it. */
export const cancel = postboxMutation({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args, session): Promise<void> => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId, 'owner', session);
		if (!owned.ok) throwForbidden('Mailbox not accessible');
		const job = await readJob(ctx, args.mailboxId);
		if (!job || job.status !== 'running') return;
		const now = Date.now();
		await ctx.db.patch(job._id, { status: 'cancelled', updatedAt: now, finishedAt: now });
	},
});

/** Operator: start (or resume) the walk of every mailbox, one page of mailboxes per call. */
export const startAll = internalMutation({
	args: { cursor: v.optional(v.union(v.string(), v.null())) },
	handler: async (ctx, args): Promise<{ started: number; isDone: boolean }> => {
		const { page, isDone, continueCursor } = await ctx.db
			.query('mailboxes')
			.paginate({ numItems: 50, cursor: args.cursor ?? null });
		let started = 0;
		for (const mailbox of page) {
			if ((await startBackfill(ctx, mailbox._id)).started) started++;
		}
		if (!isDone) {
			await ctx.scheduler.runAfter(0, internal.mail.interpret.backfill.startAll, {
				cursor: continueCursor,
			});
		}
		return { started, isDone };
	},
});

async function pause(ctx: MutationCtx, job: Job, reason: NonNullable<Job['pausedReason']>) {
	await ctx.db.patch(job._id, { status: 'paused', pausedReason: reason, updatedAt: Date.now() });
}

/** One page of threads, then the next batch after {@link BATCH_INTERVAL_MS}. */
export const runBatch = internalMutation({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args): Promise<void> => {
		// Re-read every batch, so a cancel between pages actually stops the walk.
		const job = await readJob(ctx, args.mailboxId);
		if (!job || job.status !== 'running') return;
		const mailbox = await ctx.db.get(args.mailboxId);
		if (!mailbox) {
			await ctx.db.delete(job._id);
			return;
		}
		const gate = await interpretGate(ctx, modeOfMailbox(mailbox));
		if (!gate.isAllowed) return pause(ctx, job, gate.code);
		if (job.runThreadCount >= MAX_THREADS_PER_RUN) return pause(ctx, job, 'run_cap');

		const { page, isDone, continueCursor } = await ctx.db
			.query('mailThreads')
			.withIndex('by_mailbox_and_last_message', (q) =>
				q.eq('mailboxId', args.mailboxId).gte('lastMessageAt', job.cutoffAt)
			)
			.order('desc')
			.paginate({ cursor: job.cursor ?? null, numItems: THREADS_PER_BATCH });

		let threads = 0;
		let messages = 0;
		for (const thread of page) {
			if (!isActiveThread(thread)) continue;
			const scheduled = await enqueueThreadInterpretation(
				ctx,
				{ kind: 'mail', id: thread._id },
				{ startDelayMs: messages * RUN_SPACING_MS }
			);
			if (scheduled > 0) {
				threads++;
				messages += scheduled;
			}
		}

		const now = Date.now();
		await ctx.db.patch(job._id, {
			cursor: isDone ? undefined : continueCursor,
			scannedCount: job.scannedCount + page.length,
			threadCount: job.threadCount + threads,
			runThreadCount: job.runThreadCount + threads,
			messageCount: job.messageCount + messages,
			status: isDone ? 'completed' : 'running',
			updatedAt: now,
			...(isDone ? { finishedAt: now } : {}),
		});
		if (!isDone) {
			await ctx.scheduler.runAfter(
				messages > 0 ? BATCH_INTERVAL_MS : 0,
				internal.mail.interpret.backfill.runBatch,
				{ mailboxId: args.mailboxId }
			);
		}
	},
});
