import { internalMutation } from '../_generated/server';
import type { MutationCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import {
	MAX_WEBHOOK_ATTEMPT_RECOVERIES,
	scheduleDeliveryAttempt,
	WEBHOOK_ATTEMPT_LEASE_MS,
} from './deliveryAttempts';

const RECONCILE_BATCH_SIZE = 50;

/**
 * Whether the scheduler job carrying a row's current attempt can still run or
 * finish on its own. Anything else (no job recorded, job gone, failed or
 * cancelled, or finished without recording an outcome) means the attempt is
 * lost and nothing else will ever move the row.
 */
async function attemptStillLive(
	ctx: MutationCtx,
	log: Doc<'webhookDeliveryLogs'>
): Promise<boolean> {
	if (!log.scheduledFunctionId) return false;
	const job = await ctx.db.system.get(log.scheduledFunctionId);
	return job?.state.kind === 'pending' || job?.state.kind === 'inProgress';
}

async function reconcileOne(
	ctx: MutationCtx,
	log: Doc<'webhookDeliveryLogs'>,
	now: number
): Promise<'waiting' | 'rescheduled' | 'failed'> {
	if (await attemptStillLive(ctx, log)) {
		// Scheduler backlog or a slow receiver: look again after another lease.
		await ctx.db.patch(log._id, { recoverAfter: now + WEBHOOK_ATTEMPT_LEASE_MS });
		return 'waiting';
	}

	const recoveryCount = (log.recoveryCount ?? 0) + 1;
	if (recoveryCount > MAX_WEBHOOK_ATTEMPT_RECOVERIES) {
		await ctx.db.patch(log._id, {
			status: 'failed',
			errorMessage: 'Delivery attempt never completed',
			completedAt: now,
			nextRetryAt: undefined,
			recoverAfter: undefined,
		});
		return 'failed';
	}

	// Re-issue the SAME attempt number under a new sequence: the lost attempt
	// recorded no outcome, so it does not count against maxAttempts. Bumping
	// the sequence turns the lost invocation into a no-op should it surface.
	await scheduleDeliveryAttempt(ctx, log, {
		attemptNumber: log.attemptNumber,
		delayMs: 0,
		patch: { recoveryCount },
	});
	return 'rescheduled';
}

/**
 * Recover outbound webhook deliveries whose attempt was lost: a row still
 * `pending`/`retrying` past its `recoverAfter` with no queued or running
 * scheduler job gets its attempt re-issued. Bounded per run; a full batch
 * schedules a continuation. Rows written before attempts were tracked carry
 * no `recoverAfter` and are left alone.
 */
export const reconcileOverdueDeliveries = internalMutation({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();
		const counts = { waiting: 0, rescheduled: 0, failed: 0 };
		let batchFull = false;

		for (const status of ['pending', 'retrying'] as const) {
			const overdue = await ctx.db
				.query('webhookDeliveryLogs')
				.withIndex('by_status_and_recover_after', (q) =>
					q.eq('status', status).gt('recoverAfter', 0).lte('recoverAfter', now)
				)
				.take(RECONCILE_BATCH_SIZE);
			for (const log of overdue) counts[await reconcileOne(ctx, log, now)]++;
			if (overdue.length === RECONCILE_BATCH_SIZE) batchFull = true;
		}

		if (batchFull) {
			await ctx.scheduler.runAfter(
				0,
				internal.webhooks.deliveryReconciler.reconcileOverdueDeliveries,
				{}
			);
		}
		return counts;
	},
});
