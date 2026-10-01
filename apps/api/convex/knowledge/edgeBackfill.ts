/**
 * Knowledge-graph EDGE backfill.
 *
 * The deterministic + LLM edge linkers (`knowledge.edges.linkStructural` and
 * `knowledge.edgeInference.inferRelations`) only fire on FRESH ingestion. So
 * when `ai.knowledge.autoLink` is first enabled, the existing (sparse) corpus
 * has no inferred edges and graph-augmented retrieval has nothing to traverse
 * until new mail arrives. This one-shot job walks every existing
 * `knowledgeEntries` row and schedules the LLM inference pass over it, so the
 * graph is populated retroactively.
 *
 * Mirrors `knowledge/messageBackfill.ts` (the message-extraction backfill) and
 * the `knowledge.maintenance.runKnowledgeDedup` cursor-pagination walker: page
 * the table, schedule one fire-and-forget action per entry, self-reschedule the
 * next page in its own transaction, finalize at the tail. Tracked by a one-shot
 * `knowledgeEdgeBackfillJobs` row (first-run gated by the toggle handler in
 * `workspaces/featureFlags.ts`; admin-cancellable mid-walk; idempotent —
 * re-running merges via `upsertEdge`). The job lifecycle it shares with the
 * message backfill lives in `knowledge/backfillJobs.ts`.
 *
 * Failure: the walker is a mutation, so a throw rolls back any 'failed' write
 * it could make in the same transaction. A job that stops mid-walk is instead
 * marked 'failed' by the daily stale-job sweep
 * (`knowledge.maintenance.failStaleBackfillJobs`).
 *
 * SECURITY (leak surface #2 — edge CONSTRUCTION): each entry is scheduled as its
 * OWN single-element batch, so `inferRelations` runs its candidate vector search
 * pinned to that one anchor's contact scope (a contactId, or 'org-general-only'
 * for an org-general anchor) — NEVER 'org-wide'. A backfilled edge therefore
 * can't bridge contact A → contact B. The inference action additionally
 * re-checks the `ai.knowledge.autoLink` flag and re-applies `contactScopesCanLink`
 * per edge (defense in depth), and this walker bails the moment the flag flips
 * off mid-scan.
 */

import { v } from 'convex/values';
import type { MutationCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import { publicQuery } from '../lib/authedFunctions';
import { isFeatureEnabled } from '../lib/featureFlags';
import { cancelLatestJob, createCappedJob, latestJob } from './backfillJobs';
import { knowledgeAdminMutation, resolveKnowledgeViewer } from './visibility';

/**
 * Entries paged — and `inferRelations` actions scheduled — per self-rescheduled
 * transaction. Each scheduled action is fire-and-forget, so the mutation itself
 * only does O(page) cheap `scheduler.runAfter` calls; the page bound keeps one
 * transaction's scheduled-fan-out and write budget in check.
 */
const EDGE_BACKFILL_PAGE = 50;

// ============================================================
// Job lifecycle
// ============================================================

/**
 * Create the running job for the edge walk. Called directly by the
 * `ai.knowledge.autoLink` toggle in `setFeatureFlag` (already a mutation, so
 * no `runMutation` hop). Kept in its own table so the first-run gate is
 * independent of the agent message-extraction backfill.
 */
export function createEdgeBackfillJob(ctx: MutationCtx, triggeredBy: string) {
	return createCappedJob(ctx, {
		table: 'knowledgeEdgeBackfillJobs',
		countTable: 'knowledgeEntries',
		triggeredBy,
		extraCounters: { scheduledCount: 0 },
	});
}

// ============================================================
// The workhorse — paginate entries, schedule inference, self-reschedule
// ============================================================

/**
 * Process one page of knowledge entries: schedule an `inferRelations` action per
 * entry, advance the job's cursor + counters, and either reschedule for the next
 * page or finalize the job.
 *
 * Self-rescheduling (one Convex transaction per page) keeps each invocation's
 * work bounded — the established `runKnowledgeDedup` pattern. Honors a mid-scan
 * cancel (status flipped off `running`) and a mid-scan disable of the
 * `ai.knowledge.autoLink` flag.
 */
export const runEdgeBackfill = internalMutation({
	args: {
		jobId: v.id('knowledgeEdgeBackfillJobs'),
		cursor: v.optional(v.string()),
		// Optional override for the page size (defaults to EDGE_BACKFILL_PAGE).
		// Tests pass a small value to drive multi-page pagination without seeding
		// tens of entries.
		pageSize: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const job = await ctx.db.get(args.jobId);
		if (!job) return;
		if (job.status !== 'running') return; // honor admin cancel

		// Honor a mid-walk disable of the toggle that started us.
		if (!(await isFeatureEnabled(ctx, 'ai.knowledge.autoLink'))) {
			const now = Date.now();
			await ctx.db.patch(args.jobId, {
				status: 'cancelled',
				finishedAt: now,
				updatedAt: now,
			});
			return;
		}

		const page = await ctx.db.query('knowledgeEntries').paginate({
			cursor: args.cursor ?? null,
			numItems: args.pageSize ?? EDGE_BACKFILL_PAGE,
		});

		// SECURITY: one single-entry batch per anchor keeps the candidate search
		// contact-scoped (never 'org-wide'); see the file header.
		for (const entry of page.page) {
			await ctx.scheduler.runAfter(0, internal.knowledge.edgeInference.inferRelations, {
				entryIds: [entry._id],
			});
		}

		const now = Date.now();
		await ctx.db.patch(args.jobId, {
			scannedCount: job.scannedCount + page.page.length,
			scheduledCount: job.scheduledCount + page.page.length,
			cursor: page.continueCursor,
			updatedAt: now,
		});

		if (!page.isDone) {
			await ctx.scheduler.runAfter(0, internal.knowledge.edgeBackfill.runEdgeBackfill, {
				jobId: args.jobId,
				cursor: page.continueCursor,
				pageSize: args.pageSize,
			});
		} else {
			await ctx.db.patch(args.jobId, {
				status: 'completed',
				finishedAt: now,
				updatedAt: now,
			});
		}
	},
});

// ============================================================
// Admin / dashboard surface
// ============================================================

/**
 * Most recent edge-backfill job (for the knowledge-graph dashboard's progress
 * card).
 */
export const getStatus = publicQuery({
	// public: soft-auth — org members only; returns null for anonymous/non-members
	args: {},
	handler: async (ctx) => {
		if (!(await resolveKnowledgeViewer(ctx))) return null;
		return await latestJob(ctx, 'knowledgeEdgeBackfillJobs');
	},
});

/**
 * Cancel the active (pending/running) edge-backfill job. The next page run sees
 * the 'cancelled' status and exits cleanly without rescheduling.
 *
 * Admin-only: starting/stopping the backfill is an operational lever paired with
 * the `ai.knowledge.autoLink` feature flag toggle, which is itself admin-gated.
 */
export const cancel = knowledgeAdminMutation({
	args: {},
	handler: async (ctx, _args, session) => {
		return await cancelLatestJob(ctx, {
			table: 'knowledgeEdgeBackfillJobs',
			userId: session.userId,
			auditAction: 'knowledge.edge_backfill_cancelled',
			auditResource: 'knowledge_config',
		});
	},
});
