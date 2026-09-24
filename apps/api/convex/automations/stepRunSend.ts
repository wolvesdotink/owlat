/**
 * The Send an automation email step run already produced (helper). Shared by
 * the non-campaign intake, which returns it instead of enqueuing a second one,
 * and the step claim, which completes a recovered email step whose Send
 * exists instead of re-deciding it.
 */

import type { MutationCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';

/** Newest Sends to the contact read by the legacy fallback below. */
const LEGACY_SEND_SCAN = 16;

/**
 * The Send enqueued under step run `stepRunId`, or `null`. Looked up by the step-run
 * idempotency key (`transactionalSends.automationStepRunId`).
 *
 * Release compatibility — remove the fallback after release N+1 (see
 * CONVENTIONS.md, "Old clients and workers against new functions"). v0.5.5's email step
 * enqueued without the key, and one of its actions can still be sending when
 * this release deploys; its retry then runs this release's code. So when the
 * key finds nothing, an unkeyed automation Send to the run's contact for the
 * run's automation, created after this step run was first claimed, is taken as
 * this step's Send and adopted (stamped with the key), so the retry reuses it.
 * Steps of one run execute one at a time, which is what makes "created after
 * the claim" pin it to this step. A step run that was never claimed has sent
 * nothing, so the fallback does not look.
 */
export async function findStepRunSend(
	ctx: MutationCtx,
	stepRunId: Id<'automationStepRuns'>
): Promise<Id<'transactionalSends'> | null> {
	// The key outlives its step run (contact erasure retains it), so it is
	// looked up even when the step run is already gone.
	const keyed = await ctx.db
		.query('transactionalSends')
		.withIndex('by_automation_step_run', (q) => q.eq('automationStepRunId', stepRunId))
		.first();
	if (keyed) return keyed._id;

	const stepRun = await ctx.db.get(stepRunId);
	const claimedAt = stepRun?.startedAt;
	if (!stepRun || claimedAt === undefined) return null;
	const run = await ctx.db.get(stepRun.automationRunId);
	if (!run) return null;
	const recent = await ctx.db
		.query('transactionalSends')
		.withIndex('by_contact', (q) =>
			q.eq('contactId', run.contactId).gte('_creationTime', claimedAt)
		)
		.take(LEGACY_SEND_SCAN);
	const legacy = recent.find(
		(send) =>
			send.kind === 'automation' &&
			send.automationId === run.automationId &&
			send.automationStepRunId === undefined
	);
	if (!legacy) return null;
	await ctx.db.patch(legacy._id, { automationStepRunId: stepRun._id });
	return legacy._id;
}
