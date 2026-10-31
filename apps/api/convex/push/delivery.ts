/**
 * One event's push, as `push/send.deliver` runs it: plan here (a read), push
 * from the Node action, then commit once with what happened — the devices
 * quiet hours held the event back on, and what each push service answered.
 * Holding a device back needs nothing from the network, so it waits for the
 * same commit as the answers.
 */

import { v } from 'convex/values';
import { internalQuery } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { pushEventValidator } from '../lib/validators/push';
import { holdForQuietHours, planEvent, type DeliveryPlan } from './dispatch';
import { applyPushOutcomes, pushOutcomeValidator } from './deviceWrites';

/** The pushes to make now for one event, and the devices to hold it on. */
export const planDelivery = internalQuery({
	args: { userId: v.string(), event: pushEventValidator },
	handler: async (ctx, { userId, event }): Promise<DeliveryPlan> =>
		await planEvent(ctx, userId, event),
});

/** The commit after the pushes: held devices counted, answers written back. */
export const recordDelivery = internalMutation({
	args: {
		userId: v.string(),
		held: v.array(
			v.object({ subscriptionId: v.id('pushSubscriptions'), isMarketing: v.boolean() })
		),
		outcomes: v.array(pushOutcomeValidator),
	},
	handler: async (ctx, { userId, held, outcomes }): Promise<void> => {
		await holdForQuietHours(ctx, userId, held);
		await applyPushOutcomes(ctx, outcomes);
	},
});
