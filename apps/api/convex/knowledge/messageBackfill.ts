/**
 * Knowledge Graph message backfill
 *
 * On initial agent setup (the false→true edge of the `ai.agent` feature
 * flag, kicked off from `setFeatureFlag` in
 * `workspaces/featureFlags.ts`), walks the org's existing
 * `inboundMessages` and feeds each one through the existing
 * `knowledgeExtraction.extractFromMessage` pipeline so the AI drafter has
 * historical context from day one.
 *
 * Single-org-per-deployment, so no orgId scoping. The job table is a
 * first-run gate (one job ever); cancelling and re-enabling the toggle
 * does NOT trigger a second backfill. The job lifecycle it shares with the
 * edge backfill (gate, capped create, status, cancel, stale sweep) lives in
 * `knowledge/backfillJobs.ts`.
 *
 * No `'use node'` here — `extractFromMessage` is a Node action, but we
 * invoke it via `ctx.runAction` from a regular V8 action, which is a
 * supported boundary.
 */

import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';
import { takeReceivedAtChunk } from '../lib/receivedAtCursor';
import { internalAction, internalQuery, type MutationCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { publicQuery, adminMutation } from '../lib/authedFunctions';
import { internal } from '../_generated/api';
import { isActiveOrgMember } from '../lib/sessionOrganization';
import { isFeatureEnabled } from '../lib/featureFlags';
import { cancelLatestJob, createCappedJob, latestJob } from './backfillJobs';
import { anchorActionDeadline } from '../lib/llm/actionDeadline';
import { readExtractionProgress } from './extractionProgress';
import {
	addChunkProgress,
	chunkProgressArgs,
	finishBackfillJob,
	NOTHING_SCANNED,
	scanChunk,
	type ScannedChunk,
} from './messageBackfillChunk';

// Tunables
/** Messages per `runChunk` invocation; the flag toggle starts the walk with it. */
export const DEFAULT_CHUNK_SIZE = 30;
const INTER_CHUNK_DELAY_MS = 2000;

// ============================================================
// Internal queries
// ============================================================

/**
 * Read a single job (used by chunk runner).
 */
export const loadJob = internalQuery({
	args: { jobId: v.id('knowledgeBackfillJobs') },
	handler: async (ctx, args) => ctx.db.get(args.jobId),
});

/**
 * True iff the `ai.agent` feature flag is on (with its dependency cascade).
 * Used by the chunk runner to honor mid-scan disable.
 */
export const isAgentEnabled = internalQuery({
	args: {},
	handler: async (ctx) => isFeatureEnabled(ctx, 'ai.agent'),
});

/**
 * True iff the message's extraction is complete (`extractionProgressOf`'s
 * `isDone`): an extraction a budget refusal interrupted is not, so the walker
 * resumes it (Sol r3 F3). Without a progress marker, saved entries mean done.
 * Drives idempotency; the old path (`agent/knowledgeBackfill.ts`) re-exports it.
 */
export const hasExtraction = internalQuery({
	args: { inboundMessageId: v.id('inboundMessages') },
	handler: async (ctx, args) =>
		(await readExtractionProgress(ctx, 'agent_extracted', args.inboundMessageId)).isDone,
});

/**
 * Page of inboundMessages strictly after the cursor, ordered by (receivedAt asc,
 * _id asc). The cursor is the last successfully-processed message's
 * (receivedAt, _id); on the first page both fields are undefined.
 *
 * Same-timestamp groups are drained exactly — see lib/receivedAtCursor.ts
 * for the rationale (this walker and migrationIndexing share it).
 */
export const nextChunk = internalQuery({
	args: {
		cursorReceivedAt: v.optional(v.number()),
		cursorId: v.optional(v.id('inboundMessages')),
		limit: v.number(),
	},
	handler: async (ctx, args) => {
		const { limit, cursorReceivedAt, cursorId } = args;

		const page = await takeReceivedAtChunk<Doc<'inboundMessages'>>({
			limit,
			cursorReceivedAt,
			cursorId,
			firstPage: (take) =>
				ctx.db.query('inboundMessages').withIndex('by_received_at').order('asc').take(take),
			sameTimestamp: (receivedAt) =>
				ctx.db
					.query('inboundMessages')
					.withIndex('by_received_at', (q) => q.eq('receivedAt', receivedAt))
					.collect(), // bounded: messages sharing one exact-millisecond receivedAt
			newer: (receivedAt, take) =>
				ctx.db
					.query('inboundMessages')
					.withIndex('by_received_at', (q) => q.gt('receivedAt', receivedAt))
					.order('asc')
					.take(take),
		});
		return { messages: page.rows, hasMore: page.hasMore };
	},
});

// ============================================================
// Job lifecycle
// ============================================================

/**
 * Create the running job for the message walk. Called directly by the
 * `ai.agent` toggle in `setFeatureFlag` (already a mutation, so no
 * `runMutation` hop).
 */
export function createMessageBackfillJob(ctx: MutationCtx, triggeredBy: string) {
	return createCappedJob(ctx, {
		table: 'knowledgeBackfillJobs',
		countTable: 'inboundMessages',
		triggeredBy,
		extraCounters: { extractedCount: 0, skippedCount: 0, errorCount: 0 },
	});
}

// ============================================================
// Internal mutations
// ============================================================

/**
 * Patch progress counters and advance cursor: the previous release's chunk
 * commit (its runner then rescheduled or finalized in separate calls), also
 * reached at the old path (`agent/knowledgeBackfill.ts`). Remove after
 * release N+1.
 */
export const patchProgress = internalMutation({
	args: { jobId: v.id('knowledgeBackfillJobs'), ...chunkProgressArgs },
	handler: async (ctx, { jobId, ...progress }) => {
		const job = await ctx.db.get(jobId);
		if (!job) return;
		await addChunkProgress(ctx, job, progress);
	},
});

/**
 * Move a job to a terminal state: the previous release's runner finalized
 * through this, also at the old path (`agent/knowledgeBackfill.ts`).
 * Remove after release N+1.
 */
export const finalizeJob = internalMutation({
	args: {
		jobId: v.id('knowledgeBackfillJobs'),
		status: v.union(v.literal('completed'), v.literal('cancelled'), v.literal('failed')),
		errorMessage: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		await finishBackfillJob(ctx, args.jobId, args.status, args.errorMessage);
	},
});

// ============================================================
// Internal action — the chunk workhorse
// ============================================================

/**
 * Process one chunk of inbound messages through the extraction pipeline,
 * then commit its cursor together with the next chunk or the job's terminal
 * state (`commitChunk`).
 */
export const runChunk = internalAction({
	args: {
		jobId: v.id('knowledgeBackfillJobs'),
		chunkSize: v.number(),
		// Optional override for the inter-chunk delay (defaults to INTER_CHUNK_DELAY_MS).
		// Tests pass 0 so `finishInProgressScheduledFunctions` can drain the chain
		// without real-time waits.
		interChunkDelayMs: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		// One model budget for this action, from its start.
		anchorActionDeadline(ctx);
		let chunk: ScannedChunk | null;
		try {
			chunk = await scanChunk(ctx, args);
		} catch (err) {
			console.error('[messageBackfill] runChunk failed', err);
			chunk = {
				outcome: 'failed',
				...NOTHING_SCANNED,
				errorMessage: err instanceof Error ? err.message : String(err),
			};
		}
		if (!chunk) return;
		await ctx.runMutation(internal.knowledge.messageBackfillChunk.commitChunk, {
			jobId: args.jobId,
			...chunk,
			chunkSize: args.chunkSize,
			interChunkDelayMs: args.interChunkDelayMs,
			nextChunkDelayMs: args.interChunkDelayMs ?? INTER_CHUNK_DELAY_MS,
		});
	},
});

// ============================================================
// Public surface for the dashboard
// ============================================================
//
// The one deliberate exception to "every public knowledge function follows
// `ai.knowledge`" (CONVENTIONS.md → Feature-flag floors): this job belongs to
// the agent. `setFeatureFlag` starts it on the first `ai.agent` enable,
// `runChunk` stops on `ai.agent` alone, and its card renders under the agent
// settings. Gating these two on `ai.knowledge` would hide, and make
// uncancellable, a job that is running.

/**
 * Most recent backfill job (for the progress card).
 */
export const getStatus = publicQuery({
	// public: soft-auth — org members only; returns null for anonymous/non-members
	args: {},
	handler: async (ctx) => {
		if (!(await isActiveOrgMember(ctx))) return null;
		return await latestJob(ctx, 'knowledgeBackfillJobs');
	},
});

/**
 * Cancel the active (pending/running) job. The next chunk run sees the
 * 'cancelled' status and exits cleanly.
 *
 * Admin-only: starting/stopping the backfill is an operational lever paired
 * with the `ai.agent` feature flag toggle, which is itself admin-gated.
 */
export const cancel = adminMutation({
	args: {},
	handler: async (ctx, _args, session) => {
		return await cancelLatestJob(ctx, {
			table: 'knowledgeBackfillJobs',
			userId: session.userId,
			auditAction: 'agent.backfill_cancelled',
			auditResource: 'agent_config',
		});
	},
});
