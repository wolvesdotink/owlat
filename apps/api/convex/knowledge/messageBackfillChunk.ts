/**
 * One chunk of the message knowledge backfill (`messageBackfill.ts`
 * `runChunk`): the pass that reads the chunk and runs its extractions
 * (`scanChunk`, which writes nothing itself), and the one commit of what it
 * did (`commitChunk`). Kept apart so the module with the dashboard's public
 * functions reads no inbound mail outside an internal function.
 */

import { v } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import type { ActionCtx, MutationCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import { boundedRoot } from '../lib/llm/actionDeadline';
import { rootRequest } from '../lib/llm/requestMeter';

const INTER_MESSAGE_DELAY_MS = 150;

type Job = Doc<'knowledgeBackfillJobs'>;

/** What one chunk scanned, and the cursor past it. */
export type ChunkProgress = {
	deltaScanned: number;
	deltaExtracted: number;
	deltaSkipped: number;
	deltaPartial?: number;
	deltaError: number;
	cursorReceivedAt?: number;
	cursorId?: Id<'inboundMessages'>;
};

export const chunkProgressArgs = {
	deltaScanned: v.number(),
	deltaExtracted: v.number(),
	deltaSkipped: v.number(),
	// Optional: an old walker's call (agent/knowledgeBackfill.ts) does not pass it.
	deltaPartial: v.optional(v.number()),
	deltaError: v.number(),
	cursorReceivedAt: v.optional(v.number()),
	cursorId: v.optional(v.id('inboundMessages')),
};

export async function addChunkProgress(
	ctx: MutationCtx,
	job: Job,
	args: ChunkProgress
): Promise<void> {
	await ctx.db.patch(job._id, {
		scannedCount: job.scannedCount + args.deltaScanned,
		extractedCount: job.extractedCount + args.deltaExtracted,
		skippedCount: job.skippedCount + args.deltaSkipped,
		...(args.deltaPartial ? { partialCount: (job.partialCount ?? 0) + args.deltaPartial } : {}),
		errorCount: job.errorCount + args.deltaError,
		cursorReceivedAt: args.cursorReceivedAt ?? job.cursorReceivedAt,
		cursorId: args.cursorId ?? job.cursorId,
		updatedAt: Date.now(),
	});
}

export async function finishBackfillJob(
	ctx: MutationCtx,
	jobId: Id<'knowledgeBackfillJobs'>,
	status: 'completed' | 'cancelled' | 'failed',
	errorMessage?: string
): Promise<void> {
	const now = Date.now();
	await ctx.db.patch(jobId, { status, finishedAt: now, updatedAt: now, errorMessage });
}

/**
 * Commit one chunk. `more` counts it and schedules the next chunk, `done`
 * counts it and completes the job, `disabled` cancels it (`ai.agent` went
 * off), `failed` ends it with `errorMessage`. A job that stopped running while
 * the chunk was out (an admin cancelled it) is left as it is and nothing is
 * scheduled.
 */
export const commitChunk = internalMutation({
	args: {
		jobId: v.id('knowledgeBackfillJobs'),
		outcome: v.union(
			v.literal('more'),
			v.literal('done'),
			v.literal('disabled'),
			v.literal('failed')
		),
		...chunkProgressArgs,
		errorMessage: v.optional(v.string()),
		// The next chunk's arguments, as `runChunk` takes them.
		chunkSize: v.number(),
		interChunkDelayMs: v.optional(v.number()),
		nextChunkDelayMs: v.number(),
	},
	handler: async (ctx, args): Promise<'continued' | 'finished' | 'stopped'> => {
		const job = await ctx.db.get(args.jobId);
		if (!job || job.status !== 'running') return 'stopped';
		switch (args.outcome) {
			case 'more':
				await addChunkProgress(ctx, job, args);
				await ctx.scheduler.runAfter(
					args.nextChunkDelayMs,
					internal.knowledge.messageBackfill.runChunk,
					{
						jobId: args.jobId,
						chunkSize: args.chunkSize,
						interChunkDelayMs: args.interChunkDelayMs,
					}
				);
				return 'continued';
			case 'done':
				await addChunkProgress(ctx, job, args);
				await finishBackfillJob(ctx, job._id, 'completed');
				return 'finished';
			case 'disabled':
				await finishBackfillJob(ctx, job._id, 'cancelled');
				return 'finished';
			case 'failed':
				await finishBackfillJob(ctx, job._id, 'failed', args.errorMessage);
				return 'finished';
		}
	},
});

/** What one chunk did, for `commitChunk`; `null`: nothing to commit. */
export type ScannedChunk = ChunkProgress & {
	outcome: 'more' | 'done' | 'disabled' | 'failed';
	errorMessage?: string;
};

export const NOTHING_SCANNED = {
	deltaScanned: 0,
	deltaExtracted: 0,
	deltaSkipped: 0,
	deltaError: 0,
};

/** Read one chunk and run its extractions. Commits nothing: the caller commits what it returns. */
export async function scanChunk(
	ctx: ActionCtx,
	args: { jobId: Id<'knowledgeBackfillJobs'>; chunkSize: number }
): Promise<ScannedChunk | null> {
	const job = await ctx.runQuery(internal.knowledge.messageBackfill.loadJob, {
		jobId: args.jobId,
	});
	if (!job) return null;
	if (job.status !== 'running') return null;

	// Honor mid-scan disable.
	const enabled = await ctx.runQuery(internal.knowledge.messageBackfill.isAgentEnabled, {});
	if (!enabled) return { outcome: 'disabled', ...NOTHING_SCANNED };

	const { messages, hasMore } = await ctx.runQuery(internal.knowledge.messageBackfill.nextChunk, {
		cursorReceivedAt: job.cursorReceivedAt,
		cursorId: job.cursorId,
		limit: args.chunkSize,
	});

	let deltaScanned = 0;
	let deltaExtracted = 0;
	let deltaSkipped = 0;
	let deltaPartial = 0;
	let deltaError = 0;
	let lastReceivedAt: number | undefined;
	let lastId: Id<'inboundMessages'> | undefined;

	for (const msg of messages) {
		deltaScanned++;
		lastReceivedAt = msg.receivedAt;
		lastId = msg._id;

		// Idempotency: a complete extraction is skipped; one a budget refusal
		// interrupted is resumed from its stored entries (Sol r3 F3).
		const isDone = await ctx.runQuery(internal.knowledge.messageBackfill.hasExtraction, {
			inboundMessageId: msg._id,
		});
		if (isDone) {
			deltaSkipped++;
			continue;
		}

		try {
			await ctx.runAction(internal.knowledge.extraction.extractFromMessage, {
				inboundMessageId: msg._id,
				// Awaited: it spends from this sweep's clock.
				root: boundedRoot(ctx, rootRequest('team', msg._id)),
			});
			// Re-check post-call: extractFromMessage silently no-ops on
			// short bodies, swallows internal errors and defers a budget
			// refusal. Only a complete extraction counts as "extracted"; one
			// still in progress is counted apart, and its deferral resumes it.
			const after = await ctx.runQuery(internal.knowledge.extractionProgress.extractionProgressOf, {
				sourceType: 'agent_extracted',
				sourceId: msg._id,
			});
			if (after.isDone) {
				deltaExtracted++;
			} else if (after.isPartial) {
				deltaPartial++;
			} else {
				deltaSkipped++;
			}
		} catch (err) {
			deltaError++;
			console.error('[messageBackfill] extraction error', err);
		}

		// Light rate-limit pacing between LLM calls.
		if (INTER_MESSAGE_DELAY_MS > 0) {
			await new Promise((r) => setTimeout(r, INTER_MESSAGE_DELAY_MS));
		}
	}

	return {
		outcome: hasMore ? 'more' : 'done',
		deltaScanned,
		deltaExtracted,
		deltaSkipped,
		deltaPartial,
		deltaError,
		cursorReceivedAt: lastReceivedAt,
		cursorId: lastId,
	};
}
