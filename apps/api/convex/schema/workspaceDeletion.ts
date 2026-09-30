import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * Workspace deletion jobs — the control plane of deleting the whole workspace
 * (workspaces/deletion/walker.ts).
 *
 * One row per deletion generation. The row that is `isActive` is the job in
 * progress and, while it exists, the write fence (lib/writeFence.ts) refuses
 * every insert, patch and replace on the tables the deletion sweeps. Finished
 * rows stay behind as the history of past generations, which is why the table
 * is not tenant data and the deletion never sweeps it: the job has to survive
 * the tables it empties.
 *
 * Spread into `defineSchema()` from schema.ts via `...workspaceDeletionTables`.
 */
export const workspaceDeletionTables = {
	workspaceDeletionJobs: defineTable({
		// 1 for the first deletion this deployment ever ran, then +1 per job.
		generation: v.number(),
		// True until the job completes. The fence and the singleton check read
		// the `by_is_active` index, so starting a job while another is active is
		// an OCC conflict that serializes into "join the existing job".
		isActive: v.boolean(),
		// running   — a transaction chain is (or should be) working on it;
		// retrying  — the last transaction failed and a retry is scheduled;
		// failed    — retries ran out; the recovery cron re-arms it;
		// completed — every swept table was verified empty; the fence is lifted.
		status: v.union(
			v.literal('running'),
			v.literal('retrying'),
			v.literal('failed'),
			v.literal('completed')
		),
		// sweep  — deleting table by table in the registry's order;
		// verify — checking, with the fence still up, that every table is empty.
		phase: v.union(v.literal('sweep'), v.literal('verify')),
		// The checkpoint: the table the next sweep transaction works on. Every
		// step deletes from the front of its table, so the table name is the whole
		// cursor. A plain string rather than the table union so that retiring a
		// table from the registry can never make a stored row invalid; a value the
		// registry no longer knows restarts the sweep from its first table.
		step: v.string(),
		// Who asked: the owner's "Delete workspace", an owner's account deletion,
		// or a walk the previous release had already started when this one deployed.
		source: v.union(
			v.literal('workspace_settings'),
			v.literal('account_deletion'),
			v.literal('previous_release')
		),
		requestedBy: v.optional(v.string()),
		// Further requests that joined this job instead of starting another.
		joinedRequests: v.number(),
		rowsDeleted: v.number(),
		transactions: v.number(),
		// Completed verification passes. A pass that finds rows sends the job back
		// to sweeping from that table; too many of them fail the job loudly.
		verifyPasses: v.number(),
		// Consecutive failed transactions; reset by the next successful one.
		attempts: v.number(),
		lastError: v.optional(v.string()),
		lastErrorAt: v.optional(v.number()),
		lastErrorStep: v.optional(v.string()),
		startedAt: v.number(),
		// Bumped by every transaction that makes progress: the recovery cron's
		// heartbeat.
		updatedAt: v.number(),
		completedAt: v.optional(v.number()),
	})
		.index('by_is_active', ['isActive'])
		.index('by_generation', ['generation']),
};
