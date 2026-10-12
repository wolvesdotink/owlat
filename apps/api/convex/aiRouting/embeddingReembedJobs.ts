/**
 * The re-embed job's state (ADR-0073, Phase 1a and Phase 5; #1334): one job row
 * walks `knowledgeEntries`, then `semanticFiles`, a page at a time, and writes
 * fresh vectors into its target space's column with `measured` provenance.
 *
 *   - `reembed` targets the active space: unknown rows (no space), rows of an
 *     inactive space and rows that never had a vector come back into vector
 *     search. A local embedder runs it on its own (`embeddingReembed.kickoff`);
 *     a hosted one only from an admin start, and every batch is admitted
 *     (`lib/aiRouting/embeddingAdmission.ts`).
 *   - `rebuild` targets a staged space (Phase 5): every row, into the column
 *     the active space does not use, while retrieval keeps the active one.
 *
 * Bounded and resumable: the cursor and counters are saved with each page's
 * commit, a page is idempotent (a row already in the target space is skipped),
 * and `generation` drops batches an earlier start or resume scheduled. A stalled
 * job (its action died) is resumed by the kickoff sweep.
 */

import type {
	EmbeddingSpaceState,
	ReembedJobStatus,
	ReembedPauseReason,
} from '@owlat/shared/aiRouting';
import { v } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import { internalQuery, type MutationCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { adminMutation } from '../lib/authedFunctions';
import { recordAuditLog } from '../lib/auditLog';
import { throwConflict, throwInvalidState, throwNotFound } from '../_utils/errors';
import {
	identityOf,
	isIdentityOfTarget,
	readActiveSpace,
	readConfiguredTarget,
	slotFields,
	spaceRefOf,
	vectorInSpace,
	type SpaceDoc,
} from '../lib/aiRouting/embeddingRegistry';
import { embeddingSpaceIdentityKey } from '../lib/aiRouting/embeddingKeys';
import {
	fileEmbeddingInput,
	inputFingerprint,
	knowledgeEmbeddingInput,
} from '../lib/aiRouting/embeddingInputs';
import { isPaidEmbeddingAdmissionAvailable } from '../lib/aiRouting/embeddingAdmission';
import {
	embeddingTableValidator,
	measuredEmbeddingSpaceValidator,
	reembedPauseReasonValidator,
} from '../lib/validators/embedding';

type Job = Doc<'embeddingReembedJobs'>;
type EmbeddingTable = Job['phase'];

/** Rows read per page. Each candidate costs one embedding call in the batch action. */
export const REEMBED_PAGE_SIZE = 32;
/** A running job whose last page is older than this is resumed by the kickoff sweep. */
export const REEMBED_STALL_MS = 15 * 60_000;

/** The space a job writes into must still be in the state its kind expects. */
function isTargetLive(job: Pick<Job, 'kind'>, target: SpaceDoc | null): target is SpaceDoc {
	const expected: EmbeddingSpaceState = job.kind === 'reembed' ? 'active' : 'staged';
	return target !== null && target.state === expected;
}

/** The input a row is embedded from, or null when it has none (or is expired). */
function rowInput(
	table: EmbeddingTable,
	row: Doc<'knowledgeEntries'> | Doc<'semanticFiles'>,
	now: number
): string | null {
	if (table === 'knowledgeEntries') {
		const entry = row as Doc<'knowledgeEntries'>;
		if (entry.expiresAt !== undefined && entry.expiresAt <= now) return null;
		return knowledgeEmbeddingInput(entry);
	}
	const file = row as Doc<'semanticFiles'>;
	// A file processing has not reached yet is embedded by its own pipeline.
	if (file.extractedText === undefined) return null;
	return fileEmbeddingInput(file);
}

/** The next page of a running job: the candidates and the target to embed them in. */
export const reembedPage = internalQuery({
	args: { jobId: v.id('embeddingReembedJobs'), generation: v.number() },
	handler: async (ctx, args) => {
		const job = await ctx.db.get(args.jobId);
		if (!job || job.status !== 'running' || job.generation !== args.generation) {
			return { kind: 'stop' as const };
		}
		const target = await ctx.db.get(job.targetSpaceId);
		if (!isTargetLive(job, target)) return { kind: 'stop' as const };
		const ref = spaceRefOf(target);
		const now = Date.now();
		const page = await ctx.db
			.query(job.phase)
			.paginate({ cursor: job.cursor ?? null, numItems: REEMBED_PAGE_SIZE });
		const items: { id: string; text: string; fingerprint: string }[] = [];
		for (const row of page.page) {
			if (vectorInSpace(row, ref)) continue;
			const text = rowInput(job.phase, row, now);
			if (text) items.push({ id: row._id, text, fingerprint: inputFingerprint(text) });
		}
		return {
			kind: 'page' as const,
			phase: job.phase,
			isPaid: job.isPaid,
			jobKind: job.kind,
			rootRequestId: job.rootRequestId ?? `embedding:${job._id}`,
			target,
			items,
			scanned: page.page.length,
			continueCursor: page.continueCursor,
			isDone: page.isDone,
		};
	},
});

async function endJob(
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

/**
 * Commit one page: write each fresh vector into the target space's column, save
 * the cursor and counters, and move to the next table or finish. A row edited
 * since the page was read, or already in the target space, is skipped. A
 * vector measured in another space than the target ends the job: the
 * configuration or the served model moved, and the kickoff starts over.
 */
export const reembedCommit = internalMutation({
	args: {
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
	},
	handler: async (ctx, args): Promise<{ isContinuing: boolean }> => {
		const job = await ctx.db.get(args.jobId);
		if (!job || job.status !== 'running' || job.generation !== args.generation) {
			return { isContinuing: false };
		}
		if (job.phase !== args.phase) return { isContinuing: false };
		const target = await ctx.db.get(job.targetSpaceId);
		if (!isTargetLive(job, target)) {
			await endJob(ctx, job, 'cancelled', 'space_changed');
			return { isContinuing: false };
		}
		if (args.space) {
			const { source: _source, ...identity } = args.space;
			if (embeddingSpaceIdentityKey(identity) !== target.identityKey) {
				await endJob(ctx, job, 'cancelled', 'space_changed');
				await ctx.scheduler.runAfter(0, internal.aiRouting.embeddingReembed.kickoff, {
					isForced: true,
				});
				return { isContinuing: false };
			}
		}

		const now = Date.now();
		const ref = spaceRefOf(target);
		let embedded = 0;
		let skipped = 0;
		for (const result of args.results) {
			const id = ctx.db.normalizeId(job.phase, result.id);
			const row = id ? await ctx.db.get(id) : null;
			const text = row ? rowInput(job.phase, row, now) : null;
			if (!row || !text || inputFingerprint(text) !== result.fingerprint) {
				skipped += 1;
				continue;
			}
			if (vectorInSpace(row, ref)) {
				skipped += 1;
				continue;
			}
			const entryType =
				job.phase === 'knowledgeEntries' ? (row as Doc<'knowledgeEntries'>).entryType : undefined;
			await ctx.db.patch(row._id, slotFields(target, result.vector, { now, entryType }));
			embedded += 1;
		}

		const counters = {
			scannedCount: job.scannedCount + args.scanned,
			embeddedCount: job.embeddedCount + embedded,
			skippedCount: job.skippedCount + skipped,
			failedCount: job.failedCount + args.failed,
			pausedReason: undefined,
			updatedAt: now,
		};
		if (!args.isDone) {
			await ctx.db.patch(job._id, { ...counters, cursor: args.continueCursor });
			return { isContinuing: true };
		}
		if (job.phase === 'knowledgeEntries') {
			await ctx.db.patch(job._id, { ...counters, phase: 'semanticFiles', cursor: undefined });
			return { isContinuing: true };
		}
		await ctx.db.patch(job._id, {
			...counters,
			cursor: undefined,
			status: 'completed',
			finishedAt: now,
		});
		await ctx.scheduler.runAfter(0, internal.aiRouting.embeddingCoverage.requestScan, {
			isForced: true,
		});
		return { isContinuing: false };
	},
});

/** Pause a running job (`budget`, `provider_unavailable`) without moving its cursor. */
export const pauseJob = internalMutation({
	args: {
		jobId: v.id('embeddingReembedJobs'),
		generation: v.number(),
		reason: reembedPauseReasonValidator,
		lastError: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const job = await ctx.db.get(args.jobId);
		if (!job || job.status !== 'running' || job.generation !== args.generation) return;
		await endJob(ctx, job, 'paused', args.reason, args.lastError);
	},
});

/** The running or paused job, if any. One job runs at a time. */
export async function readOpenJob(ctx: { db: MutationCtx['db'] }): Promise<Job | null> {
	for (const status of ['running', 'paused'] as const) {
		const job = await ctx.db
			.query('embeddingReembedJobs')
			.withIndex('by_status', (q) => q.eq('status', status))
			.first();
		if (job) return job;
	}
	return null;
}

/** Insert a running job and schedule its first batch. */
export async function startJob(
	ctx: MutationCtx,
	job: {
		kind: Job['kind'];
		targetSpaceId: Id<'embeddingSpaces'>;
		isPaid: boolean;
		startedBy?: string;
	}
): Promise<Id<'embeddingReembedJobs'>> {
	const now = Date.now();
	const jobId = await ctx.db.insert('embeddingReembedJobs', {
		...job,
		status: 'running',
		generation: 1,
		phase: 'knowledgeEntries',
		scannedCount: 0,
		embeddedCount: 0,
		skippedCount: 0,
		failedCount: 0,
		startedAt: now,
		updatedAt: now,
	});
	await ctx.db.patch(jobId, { rootRequestId: `embedding:${jobId}` });
	await ctx.scheduler.runAfter(0, internal.aiRouting.embeddingReembed.runBatch, {
		jobId,
		generation: 1,
	});
	return jobId;
}

/** Resume a paused or stalled job under a new generation. */
async function resumeJobRecord(ctx: MutationCtx, job: Job): Promise<void> {
	const generation = job.generation + 1;
	await ctx.db.patch(job._id, {
		status: 'running',
		pausedReason: undefined,
		generation,
		updatedAt: Date.now(),
	});
	await ctx.scheduler.runAfter(0, internal.aiRouting.embeddingReembed.runBatch, {
		jobId: job._id,
		generation,
	});
}

/** How long a completed local re-embed of the active space stands before the next pass. */
const LOCAL_REEMBED_INTERVAL_MS = 24 * 60 * 60_000;

/**
 * The local re-embed the kickoff asks for: resume a stalled or provider-paused
 * job, or start a `reembed` of the active space when none ran in the last day
 * (or `isForced`: a switch, an attestation, a settings save). Paid jobs are
 * never started here.
 */
export const startLocalReembed = internalMutation({
	args: { spaceId: v.id('embeddingSpaces'), isForced: v.boolean() },
	handler: async (ctx, args): Promise<'started' | 'resumed' | 'busy' | 'skipped'> => {
		const open = await readOpenJob(ctx);
		const now = Date.now();
		if (open) {
			const isStalled = open.status === 'running' && now - open.updatedAt > REEMBED_STALL_MS;
			const isProviderPaused =
				open.status === 'paused' && open.pausedReason === 'provider_unavailable' && !open.isPaid;
			if (isStalled || isProviderPaused) {
				await resumeJobRecord(ctx, open);
				return 'resumed';
			}
			return 'busy';
		}
		const active = await readActiveSpace(ctx.db);
		if (!active || active._id !== args.spaceId) return 'skipped';
		if (!args.isForced) {
			const last = await ctx.db
				.query('embeddingReembedJobs')
				.withIndex('by_target_space', (q) => q.eq('targetSpaceId', active._id))
				.order('desc')
				.first();
			if (last?.finishedAt !== undefined && now - last.finishedAt < LOCAL_REEMBED_INTERVAL_MS) {
				return 'skipped';
			}
		}
		await startJob(ctx, { kind: 'reembed', targetSpaceId: active._id, isPaid: false });
		return 'started';
	},
});

// ── Admin controls ─────────────────────────────────────────────────────────

/**
 * Re-embed now into the active space. With a hosted embedder this is the only
 * way a paid re-embed starts (D8), and it needs spend admission: it is refused
 * while admission is absent.
 */
export const startReembed = adminMutation({
	args: {},
	handler: async (ctx, _args, session): Promise<Id<'embeddingReembedJobs'>> => {
		const active = await readActiveSpace(ctx.db);
		const target = await readConfiguredTarget(ctx.db);
		if (!active || !target || !isIdentityOfTarget(identityOf(active), target)) {
			throwInvalidState(
				'The configured embedding model has no active space yet. Owlat activates it with the first embedded item.'
			);
		}
		if (await readOpenJob(ctx)) {
			throwConflict('A re-embed or rebuild is already running. Wait for it, or cancel it first.');
		}
		const isPaid = !target.isLocal;
		if (isPaid && !isPaidEmbeddingAdmissionAvailable()) {
			throwInvalidState(
				'Re-embedding with a hosted embedder costs money and needs spend admission, which this build does not have yet.'
			);
		}
		const jobId = await startJob(ctx, {
			kind: 'reembed',
			targetSpaceId: active._id,
			isPaid,
			startedBy: session.userId,
		});
		await recordAuditLog(ctx, {
			userId: session.userId,
			organizationId: session.activeOrganizationId,
			action: 'embedding_reembed.started',
			resource: 'embedding_space',
			resourceId: active._id,
			details: { jobId, kind: 'reembed', isPaid },
		});
		return jobId;
	},
});

/** Resume a paused job (a paid one only while admission is available). */
export const resumeReembed = adminMutation({
	args: { jobId: v.id('embeddingReembedJobs') },
	handler: async (ctx, args, session) => {
		const job = await ctx.db.get(args.jobId);
		if (!job) throwNotFound('Re-embed job');
		if (job.status !== 'paused') throwInvalidState('Only a paused job can be resumed.');
		if (job.isPaid && !isPaidEmbeddingAdmissionAvailable()) {
			throwInvalidState(
				'A paid re-embed needs spend admission, which this build does not have yet.'
			);
		}
		await resumeJobRecord(ctx, job);
		await recordAuditLog(ctx, {
			userId: session.userId,
			organizationId: session.activeOrganizationId,
			action: 'embedding_reembed.resumed',
			resource: 'embedding_space',
			resourceId: job.targetSpaceId,
			details: { jobId: job._id, kind: job.kind },
		});
	},
});

/** Cancel a running or paused re-embed. A cancelled rebuild leaves its staged space staged. */
export const cancelReembed = adminMutation({
	args: { jobId: v.id('embeddingReembedJobs') },
	handler: async (ctx, args, session) => {
		const job = await ctx.db.get(args.jobId);
		if (!job) throwNotFound('Re-embed job');
		if (job.status !== 'running' && job.status !== 'paused') return;
		await ctx.db.patch(job._id, {
			status: 'cancelled',
			generation: job.generation + 1,
			finishedAt: Date.now(),
			updatedAt: Date.now(),
		});
		await recordAuditLog(ctx, {
			userId: session.userId,
			organizationId: session.activeOrganizationId,
			action: 'embedding_reembed.cancelled',
			resource: 'embedding_space',
			resourceId: job.targetSpaceId,
			details: { jobId: job._id, kind: job.kind },
		});
	},
});
