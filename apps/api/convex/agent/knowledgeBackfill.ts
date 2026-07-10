/**
 * Knowledge Graph Backfill
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
 * does NOT trigger a second backfill.
 *
 * No `'use node'` here — `extractFromMessage` is a Node action, but we
 * invoke it via `ctx.runAction` from a regular V8 action, which is a
 * supported boundary.
 */

import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';
import { takeReceivedAtChunk } from '../lib/receivedAtCursor';
import { recordAuditLog } from '../lib/auditLog';
import { internalAction, internalMutation, internalQuery } from '../_generated/server';
import { publicQuery, adminMutation } from '../lib/authedFunctions';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { requireAdminContext, isActiveOrgMember } from '../lib/sessionOrganization';
import { isFeatureEnabled } from '../lib/featureFlags';

// Tunables
const _DEFAULT_CHUNK_SIZE = 30;
const INTER_MESSAGE_DELAY_MS = 150;
const INTER_CHUNK_DELAY_MS = 2000;
const TOTAL_COUNT_CAP = 10000;

// ============================================================
// Internal queries
// ============================================================

/**
 * True iff any backfill job (in any status) has ever been created.
 * Used by the toggle handler to gate first-run enqueue.
 */
export const hasAnyJob = internalQuery({
	args: {},
	handler: async (ctx) => {
		const existing = await ctx.db.query('knowledgeBackfillJobs').take(1);
		return existing.length > 0;
	},
});

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
 * True iff a knowledgeEntries row already exists with
 * sourceType='agent_extracted' and sourceId=inboundMessageId.
 * Drives idempotency.
 */
export const hasExtraction = internalQuery({
	args: { inboundMessageId: v.id('inboundMessages') },
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query('knowledgeEntries')
			.withIndex('by_source', (q) =>
				q.eq('sourceType', 'agent_extracted').eq('sourceId', args.inboundMessageId)
			)
			.first();
		return existing !== null;
	},
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
// Internal mutations
// ============================================================

/**
 * Insert a new running job. Counts existing inboundMessages (capped) for
 * the progress bar denominator.
 */
export const createJob = internalMutation({
	args: { triggeredBy: v.string() },
	handler: async (ctx, args) => {
		// Cheap-ish total count via capped take — good enough for a progress bar.
		// Real total is bounded by TOTAL_COUNT_CAP; the chunk runner uses cursor
		// pagination so it won't be limited by this number.
		const all = await ctx.db.query('inboundMessages').take(TOTAL_COUNT_CAP);
		const totalCount = all.length;

		const now = Date.now();
		return await ctx.db.insert('knowledgeBackfillJobs', {
			status: 'running',
			triggeredBy: args.triggeredBy,
			totalCount,
			scannedCount: 0,
			extractedCount: 0,
			skippedCount: 0,
			errorCount: 0,
			startedAt: now,
			updatedAt: now,
		});
	},
});

/**
 * Patch progress counters and advance cursor.
 */
export const patchProgress = internalMutation({
	args: {
		jobId: v.id('knowledgeBackfillJobs'),
		deltaScanned: v.number(),
		deltaExtracted: v.number(),
		deltaSkipped: v.number(),
		deltaError: v.number(),
		cursorReceivedAt: v.optional(v.number()),
		cursorId: v.optional(v.id('inboundMessages')),
	},
	handler: async (ctx, args) => {
		const job = await ctx.db.get(args.jobId);
		if (!job) return;

		await ctx.db.patch(args.jobId, {
			scannedCount: job.scannedCount + args.deltaScanned,
			extractedCount: job.extractedCount + args.deltaExtracted,
			skippedCount: job.skippedCount + args.deltaSkipped,
			errorCount: job.errorCount + args.deltaError,
			cursorReceivedAt: args.cursorReceivedAt ?? job.cursorReceivedAt,
			cursorId: args.cursorId ?? job.cursorId,
			updatedAt: Date.now(),
		});
	},
});

/**
 * Move a job to a terminal state.
 */
export const finalizeJob = internalMutation({
	args: {
		jobId: v.id('knowledgeBackfillJobs'),
		status: v.union(v.literal('completed'), v.literal('cancelled'), v.literal('failed')),
		errorMessage: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const now = Date.now();
		await ctx.db.patch(args.jobId, {
			status: args.status,
			finishedAt: now,
			updatedAt: now,
			errorMessage: args.errorMessage,
		});
	},
});

// ============================================================
// Internal action — the chunk workhorse
// ============================================================

/**
 * Process one chunk of inbound messages through the extraction pipeline,
 * advance the cursor, and either reschedule for the next chunk or finalize
 * the job.
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
		const interChunkDelay = args.interChunkDelayMs ?? INTER_CHUNK_DELAY_MS;
		try {
			const job = await ctx.runQuery(internal.agent.knowledgeBackfill.loadJob, {
				jobId: args.jobId,
			});
			if (!job) return;
			if (job.status !== 'running') return;

			// Honor mid-scan disable.
			const enabled = await ctx.runQuery(internal.agent.knowledgeBackfill.isAgentEnabled, {});
			if (!enabled) {
				await ctx.runMutation(internal.agent.knowledgeBackfill.finalizeJob, {
					jobId: args.jobId,
					status: 'cancelled',
				});
				return;
			}

			const { messages, hasMore } = await ctx.runQuery(internal.agent.knowledgeBackfill.nextChunk, {
				cursorReceivedAt: job.cursorReceivedAt,
				cursorId: job.cursorId,
				limit: args.chunkSize,
			});

			let deltaScanned = 0;
			let deltaExtracted = 0;
			let deltaSkipped = 0;
			let deltaError = 0;
			let lastReceivedAt: number | undefined;
			let lastId: Id<'inboundMessages'> | undefined;

			for (const msg of messages) {
				deltaScanned++;
				lastReceivedAt = msg.receivedAt;
				lastId = msg._id;

				// Idempotency: if this message has already been extracted, skip.
				const already = await ctx.runQuery(internal.agent.knowledgeBackfill.hasExtraction, {
					inboundMessageId: msg._id,
				});
				if (already) {
					deltaSkipped++;
					continue;
				}

				try {
					await ctx.runAction(internal.knowledge.extraction.extractFromMessage, {
						inboundMessageId: msg._id,
					});
					// Re-check post-call: extractFromMessage silently no-ops on
					// short bodies and swallows internal errors. Only count as
					// "extracted" if it actually wrote at least one entry.
					const wrote = await ctx.runQuery(internal.agent.knowledgeBackfill.hasExtraction, {
						inboundMessageId: msg._id,
					});
					if (wrote) {
						deltaExtracted++;
					} else {
						deltaSkipped++;
					}
				} catch (err) {
					deltaError++;
					// eslint-disable-next-line no-console
					console.error('[knowledgeBackfill] extraction error', err);
				}

				// Light rate-limit pacing between LLM calls.
				if (INTER_MESSAGE_DELAY_MS > 0) {
					await new Promise((r) => setTimeout(r, INTER_MESSAGE_DELAY_MS));
				}
			}

			await ctx.runMutation(internal.agent.knowledgeBackfill.patchProgress, {
				jobId: args.jobId,
				deltaScanned,
				deltaExtracted,
				deltaSkipped,
				deltaError,
				cursorReceivedAt: lastReceivedAt,
				cursorId: lastId,
			});

			if (hasMore) {
				await ctx.scheduler.runAfter(interChunkDelay, internal.agent.knowledgeBackfill.runChunk, {
					jobId: args.jobId,
					chunkSize: args.chunkSize,
					interChunkDelayMs: args.interChunkDelayMs,
				});
			} else {
				await ctx.runMutation(internal.agent.knowledgeBackfill.finalizeJob, {
					jobId: args.jobId,
					status: 'completed',
				});
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			// eslint-disable-next-line no-console
			console.error('[knowledgeBackfill] runChunk failed', err);
			try {
				await ctx.runMutation(internal.agent.knowledgeBackfill.finalizeJob, {
					jobId: args.jobId,
					status: 'failed',
					errorMessage: message,
				});
			} catch {
				// finalize best-effort
			}
		}
	},
});

// ============================================================
// Public surface for the dashboard
// ============================================================

/**
 * Most recent backfill job (for the progress card).
 */
export const getStatus = publicQuery({
	// public: soft-auth — org members only; returns null for anonymous/non-members
	args: {},
	handler: async (ctx) => {
		if (!(await isActiveOrgMember(ctx))) return null;

		const jobs = await ctx.db
			.query('knowledgeBackfillJobs')
			.withIndex('by_started_at')
			.order('desc')
			.take(1);
		return jobs.length > 0 ? jobs[0] : null;
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
	handler: async (ctx) => {
		const { userId } = await requireAdminContext(ctx);

		const jobs = await ctx.db
			.query('knowledgeBackfillJobs')
			.withIndex('by_started_at')
			.order('desc')
			.take(1);
		const job = jobs[0];
		if (!job) return false;
		if (job.status !== 'pending' && job.status !== 'running') return false;

		const now = Date.now();
		await ctx.db.patch(job._id, {
			status: 'cancelled',
			finishedAt: now,
			updatedAt: now,
		});

		await recordAuditLog(ctx, {
			userId,
			action: 'agent.backfill_cancelled',
			resource: 'agent_config',
			details: { jobId: job._id },
		});

		return true;
	},
});
