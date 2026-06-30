import { v } from 'convex/values';
import { internalMutation, internalQuery } from '../_generated/server';
import { CURRENT_WEBHOOK_PAYLOAD_VERSION } from '../lib/constants';
import { webhookPayloadValidator } from '../lib/convexValidators';
import {
	subscribableWebhookEventValidator,
	webhookEventValidator,
} from './events';

// ============ INTERNAL QUERIES ============

/**
 * Get active webhooks subscribed to a specific event
 */
export const getWebhooksForEvent = internalQuery({
	args: {
		event: subscribableWebhookEventValidator,
	},
	handler: async (ctx, args) => {
		const webhooks = await ctx.db
			.query('webhooks')
			.withIndex('by_active', (q) =>
				q.eq('isActive', true)
			)
			.collect();

		return webhooks.filter((webhook) => webhook.events.includes(args.event));
	},
});

/**
 * Get a webhook by ID
 */
export const getWebhook = internalQuery({
	args: {
		webhookId: v.id('webhooks'),
	},
	handler: async (ctx, args) => {
		return await ctx.db.get(args.webhookId);
	},
});

/**
 * Get a delivery log by ID
 */
export const getDeliveryLog = internalQuery({
	args: {
		logId: v.id('webhookDeliveryLogs'),
	},
	handler: async (ctx, args) => {
		return await ctx.db.get(args.logId);
	},
});

/**
 * List delivery logs for a webhook
 */
export const listDeliveryLogs = internalQuery({
	args: {
		webhookId: v.id('webhooks'),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const limit = args.limit ?? 50;
		const logs = await ctx.db
			.query('webhookDeliveryLogs')
			.withIndex('by_webhook', (q) => q.eq('webhookId', args.webhookId))
			.order('desc')
			.take(limit);

		return logs;
	},
});

/**
 * List recent delivery logs
 */
export const listDeliveryLogsByTeam = internalQuery({
	args: {
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const limit = args.limit ?? 50;
		const logs = await ctx.db
			.query('webhookDeliveryLogs')
			.order('desc')
			.take(limit);

		return logs;
	},
});

// ============ INTERNAL MUTATIONS ============

/**
 * Create a new delivery log entry
 */
export const createDeliveryLog = internalMutation({
	args: {
		webhookId: v.id('webhooks'),
		event: webhookEventValidator,
		// Full webhook payload object: { event, timestamp, data } — see docs/webhook-payloads.md.
		payload: webhookPayloadValidator,
		attemptNumber: v.number(),
		maxAttempts: v.number(),
	},
	handler: async (ctx, args) => {
		const now = Date.now();
		return await ctx.db.insert('webhookDeliveryLogs', {
			webhookId: args.webhookId,
			event: args.event,
			payload: args.payload,
			payloadVersion: CURRENT_WEBHOOK_PAYLOAD_VERSION,
			attemptNumber: args.attemptNumber,
			maxAttempts: args.maxAttempts,
			status: 'pending',
			scheduledAt: now,
		});
	},
});

/**
 * Update delivery log with success
 */
export const markDeliverySuccess = internalMutation({
	args: {
		logId: v.id('webhookDeliveryLogs'),
		httpStatusCode: v.number(),
		responseBody: v.optional(v.string()),
		durationMs: v.number(),
	},
	handler: async (ctx, args) => {
		const now = Date.now();
		await ctx.db.patch(args.logId, {
			status: 'success',
			httpStatusCode: args.httpStatusCode,
			responseBody: args.responseBody,
			attemptedAt: now,
			completedAt: now,
			durationMs: args.durationMs,
		});
	},
});

/**
 * Update delivery log for retry
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
		const now = Date.now();
		await ctx.db.patch(args.logId, {
			status: 'retrying',
			httpStatusCode: args.httpStatusCode,
			responseBody: args.responseBody,
			errorMessage: args.errorMessage,
			attemptedAt: now,
			nextRetryAt: args.nextRetryAt,
			attemptNumber: args.newAttemptNumber,
			durationMs: args.durationMs,
		});
	},
});

/**
 * Update delivery log with final failure
 */
export const markDeliveryFailed = internalMutation({
	args: {
		logId: v.id('webhookDeliveryLogs'),
		httpStatusCode: v.optional(v.number()),
		responseBody: v.optional(v.string()),
		errorMessage: v.string(),
		durationMs: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const now = Date.now();
		await ctx.db.patch(args.logId, {
			status: 'failed',
			httpStatusCode: args.httpStatusCode,
			responseBody: args.responseBody,
			errorMessage: args.errorMessage,
			attemptedAt: now,
			completedAt: now,
			durationMs: args.durationMs,
		});
	},
});
