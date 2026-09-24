import { v } from 'convex/values';
import { internalMutation, internalQuery } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { WEBHOOK_RETRY_DELAYS_MS } from '../lib/constants';
import { webhookPayloadValidator } from '../lib/convexValidators';
import { subscribableWebhookEventValidator, webhookEventValidator } from './events';
import {
	enqueueWebhookDelivery,
	finishDelivery,
	isOpenDeliveryStatus,
	scheduleDeliveryAttempt,
	WEBHOOK_ATTEMPT_LEASE_MS,
} from './deliveryAttempts';

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
	handler: async (ctx, args) => {
		const webhooks = await ctx.db
			.query('webhooks')
			.withIndex('by_active', (q) => q.eq('isActive', true))
			.collect(); // bounded: active webhooks (org-scale config)

		const deliveries: Array<{ webhookId: Id<'webhooks'>; logId: Id<'webhookDeliveryLogs'> }> = [];
		for (const webhook of webhooks) {
			if (!webhook.events.includes(args.event)) continue;
			const logId = await enqueueWebhookDelivery(ctx, {
				webhookId: webhook._id,
				event: args.event,
				payload: args.payload,
			});
			deliveries.push({ webhookId: webhook._id, logId });
		}
		return deliveries;
	},
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
		if (!webhook || !webhook.isActive) {
			const errorMessage = webhook ? 'Webhook is disabled' : 'Webhook not found';
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

// ============ PREVIOUS-RELEASE ENTRY POINTS ============
//
// Remove after the next release. The previous release's fanout and delivery
// actions called these by path. An action of that release still running when
// this one deploys keeps its old code but reaches these functions, so each
// keeps its original arguments and hands the work to the attempt model above:
// every row these shims open or move to `retrying` gets its attempt scheduled
// here under sequence 1, which turns the unsequenced job the old action
// schedules next into a stale no-op. Once the row carries a sequence, the
// attempt model owns it and an old action's failure or retry is dropped. Its
// success is still recorded, since the receiver did get the event.

/** A row the previous release's code still owns: open and never sequenced. */
function isLegacyOpenRow(
	log: Doc<'webhookDeliveryLogs'> | null
): log is Doc<'webhookDeliveryLogs'> {
	return log !== null && isOpenDeliveryStatus(log.status) && log.attemptSeq === undefined;
}

/** Previous release: the fanout action's subscriber lookup. */
export const getWebhooksForEvent = internalQuery({
	args: { event: subscribableWebhookEventValidator },
	handler: async (ctx, args) => {
		const webhooks = await ctx.db
			.query('webhooks')
			.withIndex('by_active', (q) => q.eq('isActive', true))
			.collect(); // bounded: active webhooks (org-scale config)
		return webhooks.filter((webhook) => webhook.events.includes(args.event));
	},
});

/** Previous release: the delivery action's webhook read. */
export const getWebhook = internalQuery({
	args: { webhookId: v.id('webhooks') },
	handler: async (ctx, args) => await ctx.db.get(args.webhookId),
});

/**
 * Previous release: the fanout action wrote the row here and scheduled the
 * attempt in a second call. The row and its first attempt are now written
 * together, so a crash before that second call loses nothing. The old
 * callers always passed attempt 1 of MAX_WEBHOOK_ATTEMPTS.
 */
export const createDeliveryLog = internalMutation({
	args: {
		webhookId: v.id('webhooks'),
		event: webhookEventValidator,
		payload: webhookPayloadValidator,
		attemptNumber: v.number(),
		maxAttempts: v.number(),
	},
	handler: async (ctx, args) =>
		await enqueueWebhookDelivery(ctx, {
			webhookId: args.webhookId,
			event: args.event,
			payload: args.payload,
		}),
});

/** Previous release: a delivery that got a 2xx. */
export const markDeliverySuccess = internalMutation({
	args: {
		logId: v.id('webhookDeliveryLogs'),
		httpStatusCode: v.number(),
		responseBody: v.optional(v.string()),
		durationMs: v.number(),
	},
	handler: async (ctx, args) => {
		const log = await ctx.db.get(args.logId);
		if (!log || !isOpenDeliveryStatus(log.status)) return;
		await finishDelivery(ctx, log._id, {
			status: 'success',
			httpStatusCode: args.httpStatusCode,
			responseBody: args.responseBody,
			durationMs: args.durationMs,
			errorMessage: undefined,
		});
	},
});

/**
 * Previous release: a failed attempt with attempts left. The old action
 * schedules the retry itself after this returns; the retry is scheduled here
 * instead, in the same transaction, and the old job becomes stale.
 */
export const markDeliveryRetrying = internalMutation({
	args: {
		logId: v.id('webhookDeliveryLogs'),
		httpStatusCode: v.optional(v.number()),
		responseBody: v.optional(v.string()),
		errorMessage: v.optional(v.string()),
		durationMs: v.optional(v.number()),
		nextRetryAt: v.number(),
		newAttemptNumber: v.number(),
	},
	handler: async (ctx, args) => {
		const log = await ctx.db.get(args.logId);
		if (!isLegacyOpenRow(log)) return;
		const now = Date.now();
		await scheduleDeliveryAttempt(ctx, log, {
			attemptNumber: args.newAttemptNumber,
			delayMs: Math.max(0, args.nextRetryAt - now),
			patch: {
				status: 'retrying',
				httpStatusCode: args.httpStatusCode,
				responseBody: args.responseBody,
				errorMessage: args.errorMessage,
				durationMs: args.durationMs,
				attemptedAt: now,
				nextRetryAt: args.nextRetryAt,
			},
		});
	},
});

/** Previous release: a final failure, or a deleted or disabled webhook. */
export const markDeliveryFailed = internalMutation({
	args: {
		logId: v.id('webhookDeliveryLogs'),
		httpStatusCode: v.optional(v.number()),
		responseBody: v.optional(v.string()),
		errorMessage: v.string(),
		durationMs: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const log = await ctx.db.get(args.logId);
		if (!isLegacyOpenRow(log)) return;
		await finishDelivery(ctx, log._id, {
			status: 'failed',
			httpStatusCode: args.httpStatusCode,
			responseBody: args.responseBody,
			errorMessage: args.errorMessage,
			durationMs: args.durationMs,
		});
	},
});
