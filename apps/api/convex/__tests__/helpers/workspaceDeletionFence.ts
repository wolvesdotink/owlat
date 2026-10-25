import type { GenericDatabaseWriter } from 'convex/server';
import type { DataModel, Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import { ORGANIZATION_DELETION_STEPS } from '../../workspaces/deletion/steps/registry';
import type { OrganizationDeletionTable } from '../../workspaces/deletion/steps/_common';

/**
 * Opens the workspace write fence (`lib/writeFence.ts`) the way a running
 * deletion holds it: one active job row, nothing else. Recovery crons read it
 * to stand down; the walker itself is not started.
 */
export async function openWorkspaceDeletionFence(ctx: {
	db: GenericDatabaseWriter<DataModel>;
}): Promise<Id<'workspaceDeletionJobs'>> {
	return await ctx.db.insert('workspaceDeletionJobs', {
		generation: 1,
		isActive: true,
		source: 'workspace_settings',
		startedAt: Date.now(),
	});
}

/** Lifts the fence the way an operator abort does, leaving the workspace's rows in place. */
export async function abortWorkspaceDeletion(
	ctx: { db: GenericDatabaseWriter<DataModel> },
	jobId: Id<'workspaceDeletionJobs'>
): Promise<void> {
	await ctx.db.patch(jobId, { isActive: false, outcome: 'aborted', endedAt: Date.now() });
}

/**
 * Runs one batch of one deletion step, the call the walker's tick makes for the
 * table it is on, without a job, the quiesce or the chain around it.
 */
export async function runDeletionStepBatch(
	t: { run: <Output>(func: (ctx: MutationCtx) => Promise<Output>) => Promise<Output> },
	table: OrganizationDeletionTable
) {
	return await t.run((ctx) => ORGANIZATION_DELETION_STEPS[table].deleteBatch(ctx));
}
