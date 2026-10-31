/**
 * One page of a re-embed job, inside the caller's transaction: the checks
 * that the job's target still holds, the page commit and the pause. The
 * mutations of `embeddingReembedJobs.ts` and the batch commit of
 * `embeddingReembedCommit.ts` share them, so there is one implementation.
 */

import type {
	EmbeddingSpaceState,
	ReembedJobStatus,
	ReembedPauseReason,
} from '@owlat/shared/aiRouting';
import { v, type Infer } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import type { DatabaseReader, MutationCtx } from '../_generated/server';
import { patchCorpusRow } from '../lib/aiRouting/embeddingActivation';
import {
	ownsColumn,
	readSearchableSpace,
	slotFields,
	spaceRefOf,
	vectorInSpace,
	type SpaceDoc,
} from '../lib/aiRouting/embeddingRegistry';
import { embeddingSpaceIdentityKey } from '../lib/aiRouting/embeddingKeys';
import { corpusRowInput, inputFingerprint } from '../lib/aiRouting/embeddingInputs';
import {
	embeddingTableValidator,
	measuredEmbeddingSpaceValidator,
} from '../lib/validators/embedding';

type Job = Doc<'embeddingReembedJobs'>;

/**
 * The space a job writes into must still be what its kind expects: a staged
 * space for a rebuild; for a re-embed, the searchable space (active and still
 * the configured target), so a job the configuration has left stops at once.
 */
export async function liveTarget(
	db: DatabaseReader,
	job: Pick<Job, 'kind' | 'targetSpaceId'>
): Promise<SpaceDoc | null> {
	let target: SpaceDoc | null;
	if (job.kind === 'rebuild') {
		const staged = await db.get(job.targetSpaceId);
		const expected: EmbeddingSpaceState = 'staged';
		target = staged?.state === expected ? staged : null;
	} else {
		const searchable = await readSearchableSpace(db);
		target = searchable?._id === job.targetSpaceId ? searchable : null;
	}
	return target && (await ownsColumn(db, target)) ? target : null;
}

/** End (or pause) a job where it stands. */
export async function endJob(
	ctx: MutationCtx,
	job: Job,
	status: Extract<ReembedJobStatus, 'paused' | 'cancelled' | 'failed'>,
	reason: ReembedPauseReason | undefined,
	lastError?: string
): Promise<void> {
	const now = Date.now();
	await ctx.db.patch(job._id, {
		status,
		pausedReason: reason,
		...(lastError !== undefined ? { lastError: lastError.slice(0, 500) } : {}),
		...(status === 'paused' ? {} : { finishedAt: now }),
		updatedAt: now,
	});
}

/** The arguments of one page's commit, as `embeddingReembed.runBatch` passes them. */
export const reembedPageArgs = {
	jobId: v.id('embeddingReembedJobs'),
	generation: v.number(),
	phase: embeddingTableValidator,
	continueCursor: v.string(),
	isDone: v.boolean(),
	scanned: v.number(),
	failed: v.number(),
	space: v.optional(measuredEmbeddingSpaceValidator),
	results: v.array(
		v.object({ id: v.string(), vector: v.array(v.float64()), fingerprint: v.string() })
	),
};
const reembedPageValidator = v.object(reembedPageArgs);

/** One page's commit, inside the caller's transaction (see `embeddingReembedJobs.reembedCommit`). */
export async function commitReembedPage(
	ctx: MutationCtx,
	args: Infer<typeof reembedPageValidator>
): Promise<{ outcome: 'continue' | 'retry' | 'stop'; unresolved: number }> {
	const stop = { outcome: 'stop' as const, unresolved: 0 };
	const job = await ctx.db.get(args.jobId);
	if (!job || job.status !== 'running' || job.generation !== args.generation) return stop;
	if (job.phase !== args.phase) return stop;
	const target = await liveTarget(ctx.db, job);
	if (!target) {
		await endJob(ctx, job, 'cancelled', 'space_changed');
		return stop;
	}
	if (args.space) {
		const { source: _source, ...identity } = args.space;
		if (embeddingSpaceIdentityKey(identity) !== target.identityKey) {
			await endJob(ctx, job, 'cancelled', 'space_changed');
			await ctx.scheduler.runAfter(0, internal.aiRouting.embeddingReembed.kickoff, {
				isForced: true,
			});
			return stop;
		}
	}

	const now = Date.now();
	const ref = spaceRefOf(target);
	const entryTypeOf = (row: Doc<'knowledgeEntries'> | Doc<'semanticFiles'>) =>
		job.phase === 'knowledgeEntries' ? (row as Doc<'knowledgeEntries'>).entryType : undefined;
	let embedded = 0;
	let unresolved = args.failed;
	for (const result of args.results) {
		const id = ctx.db.normalizeId(job.phase, result.id);
		const row = id ? await ctx.db.get(id) : null;
		if (!row || vectorInSpace(row, ref)) continue;
		const text = corpusRowInput(job.phase, row, now);
		if (!text) continue;
		if (inputFingerprint(text) !== result.fingerprint) {
			unresolved += 1;
			continue;
		}
		await patchCorpusRow(
			ctx,
			job.phase,
			row,
			slotFields(target, result.vector, { now, entryType: entryTypeOf(row) }),
			{ written: target.slot }
		);
		embedded += 1;
	}

	const counters = {
		embeddedCount: job.embeddedCount + embedded,
		failedCount: job.failedCount + unresolved,
		pausedReason: undefined,
		updatedAt: now,
	};
	if (unresolved > 0) {
		// Keep the cursor: the retry re-reads the page, whose landed rows are no
		// longer candidates.
		await ctx.db.patch(job._id, counters);
		return { outcome: 'retry', unresolved };
	}
	const advanced = {
		...counters,
		scannedCount: job.scannedCount + args.scanned,
	};
	if (!args.isDone) {
		await ctx.db.patch(job._id, { ...advanced, cursor: args.continueCursor });
		return { outcome: 'continue', unresolved: 0 };
	}
	if (job.phase === 'knowledgeEntries') {
		await ctx.db.patch(job._id, { ...advanced, phase: 'semanticFiles', cursor: undefined });
		return { outcome: 'continue', unresolved: 0 };
	}
	await ctx.db.patch(job._id, {
		...advanced,
		cursor: undefined,
		status: 'completed',
		finishedAt: now,
	});
	await ctx.scheduler.runAfter(0, internal.aiRouting.embeddingCoverage.requestScan, {
		isForced: true,
	});
	return stop;
}

/** Pause a running job of `generation` without moving its cursor; any other job is left alone. */
export async function pauseRunningJob(
	ctx: MutationCtx,
	args: {
		jobId: Id<'embeddingReembedJobs'>;
		generation: number;
		reason: ReembedPauseReason;
		lastError?: string;
	}
): Promise<void> {
	const job = await ctx.db.get(args.jobId);
	if (!job || job.status !== 'running' || job.generation !== args.generation) return;
	await endJob(ctx, job, 'paused', args.reason, args.lastError);
}
