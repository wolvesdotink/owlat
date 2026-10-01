import type { GenericDatabaseWriter } from 'convex/server';
import type { DataModel, Id } from '../../_generated/dataModel';

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
