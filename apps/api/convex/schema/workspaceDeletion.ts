import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * Workspace deletion — the control plane of deleting the whole workspace
 * (workspaces/deletion/). Two tables, split by how often they change:
 *
 *   workspaceDeletionJobs      one row per deletion generation. The row that is
 *                              `isActive` IS the write fence (lib/writeFence.ts):
 *                              every writing transaction reads the
 *                              `by_is_active` range, so this row is written only
 *                              when a generation opens and when it ends.
 *   workspaceDeletionProgress  the job's checkpoint and counters, written by
 *                              every walker transaction. Kept off the fence row
 *                              so a checkpoint never conflicts with a writer
 *                              that merely read the fence.
 *
 * Neither is tenant data and the deletion never sweeps them: the job has to
 * survive the tables it empties, and finished rows are the generation history.
 *
 * Spread into `defineSchema()` from schema.ts via `...workspaceDeletionTables`.
 */
export const workspaceDeletionTables = {
	workspaceDeletionJobs: defineTable({
		// 1 for the first deletion this deployment ever ran, then +1 per job.
		generation: v.number(),
		// True until the job completes or an operator aborts it. Starting a job
		// while another is active is an OCC conflict on this index range, which
		// serializes into "join the existing job".
		isActive: v.boolean(),
		// Who asked: the owner's "Delete workspace", an owner's account deletion,
		// or a walk the previous release had already started when this one deployed.
		source: v.union(
			v.literal('workspace_settings'),
			v.literal('account_deletion'),
			v.literal('previous_release')
		),
		requestedBy: v.optional(v.string()),
		startedAt: v.number(),
		// Set with `isActive: false`: when the fence came down, and why.
		endedAt: v.optional(v.number()),
		outcome: v.optional(v.union(v.literal('completed'), v.literal('aborted'))),
		// An operator abort records who lifted the fence and why.
		abortedBy: v.optional(v.string()),
		abortReason: v.optional(v.string()),
	})
		.index('by_is_active', ['isActive'])
		.index('by_generation', ['generation']),

	workspaceDeletionProgress: defineTable({
		jobId: v.id('workspaceDeletionJobs'),
		// running   — a transaction chain is (or should be) working on it;
		// retrying  — the last transaction failed and a retry is scheduled;
		// failed    — retries ran out; the recovery cron re-arms it;
		// completed — every swept table was verified empty;
		// aborted   — an operator lifted the fence before completion.
		status: v.union(
			v.literal('running'),
			v.literal('retrying'),
			v.literal('failed'),
			v.literal('completed'),
			v.literal('aborted')
		),
		// quiesce — cancelling the workspace's pending scheduled functions;
		// sweep   — deleting table by table in the registry's order;
		// verify  — with the fence up, re-checking the scheduler and that every
		//           table is empty.
		phase: v.union(v.literal('quiesce'), v.literal('sweep'), v.literal('verify')),
		// The sweep checkpoint: the table the next sweep transaction works on.
		// Every step deletes from the front of its table, so the table name is
		// the whole cursor. A plain string rather than the table union so that
		// retiring a table from the registry can never make a stored row invalid;
		// a value the registry no longer knows restarts the sweep from its first
		// table.
		step: v.string(),
		// The scheduler scan's cursor: the `_creationTime` of the last
		// `_scheduled_functions` row inspected.
		scheduledCursor: v.optional(v.number()),
		scheduledCancelled: v.number(),
		// Further requests that joined this job instead of starting another.
		joinedRequests: v.number(),
		rowsDeleted: v.number(),
		transactions: v.number(),
		// Verification passes that found rows since the job was (re-)armed. Too
		// many fail the job loudly; re-arming starts the count again.
		verifyPasses: v.number(),
		// Times a failed job was re-armed (by the recovery cron or a new request).
		rearms: v.number(),
		// Consecutive failed transactions; reset by the next successful one.
		attempts: v.number(),
		lastError: v.optional(v.string()),
		lastErrorAt: v.optional(v.number()),
		lastErrorStep: v.optional(v.string()),
		// Bumped by every transaction that makes progress: the recovery cron's
		// heartbeat.
		updatedAt: v.number(),
	}).index('by_job', ['jobId']),
};
