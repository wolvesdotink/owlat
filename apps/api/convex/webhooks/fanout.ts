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
 * fanout dispatcher above it: the delivery rows and their first attempts are
 * written by one mutation each (`deliveryQueries.enqueue*`), so a crash here
 * can never leave a row with no attempt scheduled.
 */

import { v } from 'convex/values';
import { internalAction } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { jsonPrimitiveRecord } from '../lib/convexValidators';
import { subscribableWebhookEventValidator, webhookEventValidator } from './events';

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

		const deliveries = await ctx.runMutation(
			internal.webhooks.deliveryQueries.enqueueFanoutDeliveries,
			{ event, payload: { event, timestamp: new Date().toISOString(), data } }
		);

		return { success: true, webhooksTriggered: deliveries.length, deliveries };
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

		const logId = await ctx.runMutation(internal.webhooks.deliveryQueries.enqueueDelivery, {
			webhookId,
			event,
			payload: { event, timestamp: new Date().toISOString(), data },
		});
		if (!logId) return { success: false, error: 'Webhook not found' };

		return { success: true, logId };
	},
});
