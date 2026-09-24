'use node';

/**
 * PREVIOUS-RELEASE ENTRY POINTS — remove after the next release.
 *
 * `scheduleFanout` / `scheduleDeliver` (webhooks/scheduleFanout.ts) used to
 * schedule these two actions, which then wrote the delivery rows. They now
 * schedule the enqueue mutations in `deliveryQueries.ts` directly: a scheduled
 * action runs at most once, so one that failed after being dequeued dropped
 * the event before any delivery row existed. These actions stay only so jobs
 * the previous release queued under these paths before the deploy still run;
 * each makes the same single mutation call the new path schedules.
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

/** Previous-release job shape of `scheduleFanout`. */
export const fanoutEvent = internalAction({
	args: {
		event: subscribableWebhookEventValidator,
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

/** Previous-release job shape of `scheduleDeliver`. */
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
