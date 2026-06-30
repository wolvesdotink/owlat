'use node';

/**
 * Webhook event fanout — the single entry point for shipping an outbound
 * Webhook event to subscribed customer webhooks. See CONTEXT.md "Webhook
 * event fanout".
 *
 * Replaces the prior `fireWebhookEvent` (fanout-to-all) and
 * `deliverWebhook` (per-webhook delivery) actions in `webhooks/delivery.ts`
 * — both collapse into one path that the typed `scheduleFanout` /
 * `scheduleDeliver` helpers feed.
 *
 * The actual HTTP delivery + retry machinery still lives in
 * `webhooks/delivery.ts::deliverWebhookInternal`. This module is only the
 * fanout dispatcher above it.
 */

import { v } from 'convex/values';
import { MAX_WEBHOOK_ATTEMPTS } from '../lib/constants';
import { internalAction } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { jsonPrimitiveRecord } from '../lib/convexValidators';
import {
	subscribableWebhookEventValidator,
	webhookEventValidator,
} from './events';



interface FanoutResult {
	success: boolean;
	webhooksTriggered: number;
	deliveries?: Array<{
		webhookId: Id<'webhooks'>;
		logId: Id<'webhookDeliveryLogs'>;
	}>;
}

interface DeliverResult {
	success: boolean;
	error?: string;
	logId?: Id<'webhookDeliveryLogs'>;
}

/**
 * Fan an event out to every active subscribed webhook.
 *
 * Callers should not invoke this action directly — use the typed
 * `scheduleFanout` helper in `webhooks/scheduleFanout.ts`, which builds
 * the payload via the per-event module before scheduling.
 */
export const fanoutEvent = internalAction({
	args: {
		// Fanout-to-all is restricted to subscribable events. The synthetic
		// `test` event is only delivered per-target via `deliverEvent`.
		event: subscribableWebhookEventValidator,
		// Pre-built data per the per-event module's schema. The typed
		// helper calls module.build before scheduling — this validator is
		// the wire shape only.
		data: jsonPrimitiveRecord,
	},
	handler: async (ctx, args): Promise<FanoutResult> => {
		const { event, data } = args;

		const webhooks: Doc<'webhooks'>[] = await ctx.runQuery(
			internal.webhooks.deliveryQueries.getWebhooksForEvent,
			{ event }
		);

		if (webhooks.length === 0) {
			return { success: true, webhooksTriggered: 0 };
		}

		const payloadObj = {
			event,
			timestamp: new Date().toISOString(),
			data,
		};
		const payloadStr = JSON.stringify(payloadObj);

		const results = await Promise.all(
			webhooks.map(async (webhook) => {
				const logId = await ctx.runMutation(
					internal.webhooks.deliveryQueries.createDeliveryLog,
					{
						webhookId: webhook._id,
						event,
						payload: payloadObj,
						attemptNumber: 1,
						maxAttempts: MAX_WEBHOOK_ATTEMPTS,
					}
				);

				await ctx.scheduler.runAfter(
					0,
					internal.webhooks.delivery.deliverWebhookInternal,
					{
						webhookId: webhook._id,
						logId,
						payload: payloadStr,
						attemptNumber: 1,
					}
				);

				return { webhookId: webhook._id, logId };
			})
		);

		return {
			success: true,
			webhooksTriggered: webhooks.length,
			deliveries: results,
		};
	},
});

/**
 * Deliver an event to a specific webhook (used by the test-fire button and
 * by callers with a single intended target). Callers should use the typed
 * `scheduleDeliver` helper rather than invoking this directly.
 */
export const deliverEvent = internalAction({
	args: {
		webhookId: v.id('webhooks'),
		event: webhookEventValidator,
		data: jsonPrimitiveRecord,
	},
	handler: async (ctx, args): Promise<DeliverResult> => {
		const { webhookId, event, data } = args;

		const webhook = await ctx.runQuery(
			internal.webhooks.deliveryQueries.getWebhook,
			{ webhookId }
		);
		if (!webhook) return { success: false, error: 'Webhook not found' };

		const payloadObj = {
			event,
			timestamp: new Date().toISOString(),
			data,
		};
		const payloadStr = JSON.stringify(payloadObj);

		const logId = await ctx.runMutation(
			internal.webhooks.deliveryQueries.createDeliveryLog,
			{
				webhookId,
				event,
				payload: payloadObj,
				attemptNumber: 1,
				maxAttempts: MAX_WEBHOOK_ATTEMPTS,
			}
		);

		await ctx.scheduler.runAfter(
			0,
			internal.webhooks.delivery.deliverWebhookInternal,
			{
				webhookId,
				logId,
				payload: payloadStr,
				attemptNumber: 1,
			}
		);

		return { success: true, logId };
	},
});
