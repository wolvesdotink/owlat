/**
 * Outbound webhook attempt bookkeeping, shared by every mutation that starts,
 * retries or recovers a delivery.
 *
 * The rule these helpers exist to enforce: the row state that says "an attempt
 * is due" and the scheduler job that performs it are written in ONE mutation.
 * Before, an action persisted the row and then scheduled the attempt in a
 * separate call, so a crash between the two left a `pending`/`retrying` row
 * that nothing would ever deliver. Each attempt also gets a sequence number
 * (`attemptSeq`) that the invocation must present back, which is what turns
 * duplicate and superseded invocations into no-ops.
 */

import type { MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import { CURRENT_WEBHOOK_PAYLOAD_VERSION, MAX_WEBHOOK_ATTEMPTS } from '../lib/constants';

type DeliveryLog = Doc<'webhookDeliveryLogs'>;

/**
 * How long a scheduled or claimed attempt may go without an outcome before the
 * reconciler looks at it. The request itself times out after 30 s; the rest is
 * slack for scheduler lag. The reconciler also checks the scheduler job and
 * leaves a still-queued or still-running attempt alone, so a lease that is too
 * short costs a re-check, never a duplicate send.
 */
export const WEBHOOK_ATTEMPT_LEASE_MS = 5 * 60_000;

/** Re-issues of a lost attempt before the delivery is declared failed. */
export const MAX_WEBHOOK_ATTEMPT_RECOVERIES = 3;

/** Statuses that still expect an attempt to run. */
export function isOpenDeliveryStatus(status: DeliveryLog['status']): boolean {
	return status === 'pending' || status === 'retrying';
}

/**
 * Schedule the next attempt for a delivery row and record its identity on the
 * row in the same transaction. `patch` carries the status fields the caller is
 * moving the row to, so persistence and scheduling cannot separate.
 */
export async function scheduleDeliveryAttempt(
	ctx: MutationCtx,
	log: Pick<DeliveryLog, '_id' | 'webhookId' | 'attemptSeq'>,
	opts: {
		attemptNumber: number;
		delayMs: number;
		patch?: Partial<Omit<DeliveryLog, '_id' | '_creationTime'>>;
	}
): Promise<number> {
	const attemptSeq = (log.attemptSeq ?? 0) + 1;
	const scheduledFunctionId = await ctx.scheduler.runAfter(
		opts.delayMs,
		internal.webhooks.delivery.deliverWebhookInternal,
		{
			webhookId: log.webhookId,
			logId: log._id,
			attemptNumber: opts.attemptNumber,
			attemptSeq,
		}
	);
	await ctx.db.patch(log._id, {
		...opts.patch,
		attemptNumber: opts.attemptNumber,
		attemptSeq,
		scheduledFunctionId,
		attemptClaimedAt: undefined,
		recoverAfter: Date.now() + opts.delayMs + WEBHOOK_ATTEMPT_LEASE_MS,
	});
	return attemptSeq;
}

/**
 * End a delivery. Every terminal outcome goes through here, so a success, a
 * final failure and a delivery the reconciler gives up on leave the row in the
 * same shape for the delivery log. `attemptedAt` defaults to now; a caller that
 * ends a row without sending passes the row's own value to keep it.
 */
export async function finishDelivery(
	ctx: MutationCtx,
	logId: Id<'webhookDeliveryLogs'>,
	fields: Partial<DeliveryLog> & { status: 'success' | 'failed' }
): Promise<void> {
	const now = Date.now();
	await ctx.db.patch(logId, {
		attemptedAt: now,
		...fields,
		completedAt: now,
		nextRetryAt: undefined,
		recoverAfter: undefined,
	});
}

/**
 * Create a delivery row for one webhook and schedule its first attempt. The
 * row id doubles as the receiver-facing delivery id (`X-Webhook-Delivery-Id`),
 * which stays the same across every retry of this delivery.
 */
export async function enqueueWebhookDelivery(
	ctx: MutationCtx,
	args: {
		webhookId: Id<'webhooks'>;
		event: DeliveryLog['event'];
		payload: DeliveryLog['payload'];
	}
): Promise<Id<'webhookDeliveryLogs'>> {
	const logId = await ctx.db.insert('webhookDeliveryLogs', {
		webhookId: args.webhookId,
		event: args.event,
		payload: args.payload,
		payloadVersion: CURRENT_WEBHOOK_PAYLOAD_VERSION,
		attemptNumber: 1,
		maxAttempts: MAX_WEBHOOK_ATTEMPTS,
		status: 'pending',
		scheduledAt: Date.now(),
	});
	await scheduleDeliveryAttempt(
		ctx,
		{ _id: logId, webhookId: args.webhookId, attemptSeq: undefined },
		{ attemptNumber: 1, delayMs: 0 }
	);
	return logId;
}
