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
 * Mirrors `agent/knowledgeBackfill.ts` (the message-extraction backfill) and the
 * `knowledge.maintenance.runKnowledgeDedup` cursor-pagination walker: page the
 * table, schedule one fire-and-forget action per entry, self-reschedule the next
 * page in its own transaction, finalize at the tail. Tracked by a one-shot
 * `knowledgeEdgeBackfillJobs` row (first-run gated by the toggle handler in
 * `workspaces/featureFlags.ts`; admin-cancellable mid-walk; idempotent —
 * re-running merges via `upsertEdge`).
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
import { internalQuery, internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';
import { publicQuery, adminMutation } from '../lib/authedFunctions';
import { isActiveOrgMember, requireAdminContext } from '../lib/sessionOrganization';
import { isFeatureEnabled } from '../lib/featureFlags';
import { recordAuditLog } from '../lib/auditLog';

/**
 * Entries paged — and `inferRelations` actions scheduled — per self-rescheduled
 * transaction. Each scheduled action is fire-and-forget, so the mutation itself
 * only does O(page) cheap `scheduler.runAfter` calls; the page bound keeps one
 * transaction's scheduled-fan-out and write budget in check.
 */
const EDGE_BACKFILL_PAGE = 50;

/**
 * Capped count of existing entries used purely as the progress-bar denominator.
 * The walker uses cursor pagination, so it is never limited by this number.
 */
const TOTAL_COUNT_CAP = 10000;

// ============================================================
// First-run gate
// ============================================================

/**
 * True iff any edge-backfill job (in any status) has ever been created. The
 * toggle handler gates first-run enqueue on this, so cancelling and re-enabling
 * `ai.knowledge.autoLink` does NOT trigger a second backfill. Kept in its own
 * table so the gate is independent of the agent message-extraction backfill.
 */
export const hasAnyJob = internalQuery({
	args: {},
	handler: async (ctx) => {
		const existing = await ctx.db.query('knowledgeEdgeBackfillJobs').take(1);
		return existing.length > 0;
	},
});

// ============================================================
// Job lifecycle
// ============================================================

/**
 * Insert a new running job. Counts existing knowledgeEntries (capped) for the
 * progress-bar denominator.
 */
export const createJob = internalMutation({
	args: { triggeredBy: v.string() },
	handler: async (ctx, args) => {
		const all = await ctx.db.query('knowledgeEntries').take(TOTAL_COUNT_CAP);
		const now = Date.now();
		return await ctx.db.insert('knowledgeEdgeBackfillJobs', {
			status: 'running',
			triggeredBy: args.triggeredBy,
			totalCount: all.length,
			scannedCount: 0,
			scheduledCount: 0,
			startedAt: now,
			updatedAt: now,
		});
	},
});

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
		if (!(await isActiveOrgMember(ctx))) return null;

		const jobs = await ctx.db
			.query('knowledgeEdgeBackfillJobs')
			.withIndex('by_started_at')
			.order('desc')
			.take(1);
		return jobs.length > 0 ? jobs[0] : null;
	},
});

/**
 * Cancel the active (pending/running) edge-backfill job. The next page run sees
 * the 'cancelled' status and exits cleanly without rescheduling.
 *
 * Admin-only: starting/stopping the backfill is an operational lever paired with
 * the `ai.knowledge.autoLink` feature flag toggle, which is itself admin-gated.
 */
export const cancel = adminMutation({
	args: {},
	handler: async (ctx) => {
		const { userId } = await requireAdminContext(ctx);

		const jobs = await ctx.db
			.query('knowledgeEdgeBackfillJobs')
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
			action: 'knowledge.edge_backfill_cancelled',
			resource: 'knowledge_config',
			details: { jobId: job._id },
		});

		return true;
	},
});
