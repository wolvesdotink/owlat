import { v } from 'convex/values';
import { internalMutation } from '../lib/writeFence';
import type { Doc } from '../_generated/dataModel';
import { WEBHOOK_RETRY_DELAYS_MS } from '../lib/constants';
import { isFeatureEnabled } from '../lib/featureFlags';
import { webhookPayloadValidator } from '../lib/convexValidators';
import { subscribableWebhookEventValidator, webhookEventValidator } from './events';
import {
	enqueueSubscribedDeliveries,
	enqueueWebhookDelivery,
	finishDelivery,
	isOpenDeliveryStatus,
	scheduleDeliveryAttempt,
	WEBHOOK_ATTEMPT_LEASE_MS,
} from './deliveryAttempts';
import { isEventAllowedOverUrl } from './urlPolicy';

// ============ INTERNAL MUTATIONS ============

/**
 * Fan one event out to every active subscribed webhook: one delivery row per
 * webhook, each with its first attempt scheduled in this same transaction.
 */
export const enqueueFanoutDeliveries = internalMutation({
	args: {
		event: subscribableWebhookEventValidator,
		// Full webhook payload object: { event, timestamp, data } — see docs/webhook-payloads.md.
		payload: webhookPayloadValidator,
	},
	handler: async (ctx, args) => await enqueueSubscribedDeliveries(ctx, args.event, args.payload),
});

/**
 * Create one delivery row for a specific webhook and schedule its first
 * attempt in the same transaction. Returns null when the webhook is gone.
 */
export const enqueueDelivery = internalMutation({
	args: {
		webhookId: v.id('webhooks'),
		event: webhookEventValidator,
		payload: webhookPayloadValidator,
	},
	handler: async (ctx, args) => {
		const webhook = await ctx.db.get(args.webhookId);
		if (!webhook) return null;
		if (!(await isFeatureEnabled(ctx, 'webhooks'))) return null;
		return await enqueueWebhookDelivery(ctx, args);
	},
});

type ClaimResult =
	| { kind: 'deliver'; url: string; secret: string; payload: string }
	| { kind: 'skip'; reason: string };

/** An invocation's view of which attempt it is carrying. */
const attemptRefArgs = {
	logId: v.id('webhookDeliveryLogs'),
	attemptNumber: v.number(),
	// Absent only on invocations scheduled before attempts carried a sequence.
	attemptSeq: v.optional(v.number()),
};

/**
 * Whether an invocation still owns the row's current attempt. A stale one
 * (the row finished, or the attempt was superseded by a retry or a reconciler
 * re-issue) must not send or record anything.
 */
function isCurrentAttempt(
	log: Doc<'webhookDeliveryLogs'>,
	ref: { attemptNumber: number; attemptSeq?: number }
): boolean {
	return (
		isOpenDeliveryStatus(log.status) &&
		log.attemptSeq === ref.attemptSeq &&
		log.attemptNumber === ref.attemptNumber
	);
}

/**
 * Claim the current attempt before sending. Exactly one invocation per attempt
 * gets `deliver`; a duplicate invocation of the same attempt, a superseded one
 * and one arriving after the row finished all get `skip`. A deleted or
 * disabled webhook ends the delivery here.
 */
export const claimDeliveryAttempt = internalMutation({
	args: attemptRefArgs,
	handler: async (ctx, args): Promise<ClaimResult> => {
		const log = await ctx.db.get(args.logId);
		if (!log) return { kind: 'skip', reason: 'Delivery log not found' };
		if (!isCurrentAttempt(log, args)) return { kind: 'skip', reason: 'Stale attempt' };
		if (log.attemptClaimedAt !== undefined)
			return { kind: 'skip', reason: 'Attempt already claimed' };

		const webhook = await ctx.db.get(log.webhookId);
		const featureOn = await isFeatureEnabled(ctx, 'webhooks');
		if (
			!webhook ||
			!webhook.isActive ||
			!featureOn ||
			!isEventAllowedOverUrl(log.event, webhook.url)
		) {
			const errorMessage = !webhook
				? 'Webhook not found'
				: !webhook.isActive
					? 'Webhook is disabled'
					: !featureOn
						? 'Outbound webhooks are turned off'
						: 'This event needs an HTTPS webhook URL';
			await finishDelivery(ctx, log._id, { status: 'failed', errorMessage });
			return { kind: 'skip', reason: errorMessage };
		}

		const now = Date.now();
		await ctx.db.patch(log._id, {
			attemptClaimedAt: now,
			recoverAfter: now + WEBHOOK_ATTEMPT_LEASE_MS,
		});
		return {
			kind: 'deliver',
			url: webhook.url,
			secret: webhook.secret,
			payload: JSON.stringify(log.payload),
		};
	},
});

/**
 * Record what an attempt got back. On failure with attempts left, the row
 * moves to `retrying` and the next attempt is scheduled in this transaction.
 * An outcome from an attempt that no longer owns the row is dropped.
 */
export const recordDeliveryAttempt = internalMutation({
	args: {
		...attemptRefArgs,
		ok: v.boolean(),
		httpStatusCode: v.optional(v.number()),
		responseBody: v.optional(v.string()),
		errorMessage: v.optional(v.string()),
		durationMs: v.number(),
	},
	handler: async (ctx, args): Promise<{ recorded: boolean; retrying: boolean }> => {
		const log = await ctx.db.get(args.logId);
		if (!log || !isCurrentAttempt(log, args)) return { recorded: false, retrying: false };

		const response = {
			httpStatusCode: args.httpStatusCode,
			responseBody: args.responseBody,
			durationMs: args.durationMs,
		};
		if (args.ok) {
			await finishDelivery(ctx, log._id, {
				status: 'success',
				...response,
				errorMessage: undefined,
			});
			return { recorded: true, retrying: false };
		}

		if (args.attemptNumber < log.maxAttempts) {
			const now = Date.now();
			const delayMs = WEBHOOK_RETRY_DELAYS_MS[args.attemptNumber] ?? 5 * 60_000;
			await scheduleDeliveryAttempt(ctx, log, {
				attemptNumber: args.attemptNumber + 1,
				delayMs,
				patch: {
					status: 'retrying',
					...response,
					errorMessage: args.errorMessage,
					attemptedAt: now,
					nextRetryAt: now + delayMs,
				},
			});
			return { recorded: true, retrying: true };
		}

		await finishDelivery(ctx, log._id, {
			status: 'failed',
			...response,
			errorMessage: args.errorMessage || 'Max retries exceeded',
		});
		return { recorded: true, retrying: false };
	},
});
