/**
 * One event's push, as `push/send.deliver` runs it: plan here (a read), push
 * from the Node action, then commit once with what happened — the devices
 * quiet hours held the event back on, and what each push service answered.
 * Holding a device back needs nothing from the network, so it waits for the
 * same commit as the answers.
 */

import { v, type Infer } from 'convex/values';
import { internalQuery, type MutationCtx } from '../_generated/server';
import { recordAlertPushOutcomes } from '../delivery/checklistAlertChannelLedger';
import { internalMutation } from '../lib/writeFence';
import { pushEventValidator } from '../lib/validators/push';
import { MAX_DEVICES_PER_USER, holdForQuietHours, planEvent, type DeliveryPlan } from './dispatch';
import { applyPushOutcomes, pushOutcomeValidator } from './deviceWrites';

/** The pushes to make now for one event, and the devices to hold it on. */
export const planDelivery = internalQuery({
	args: { userId: v.string(), event: pushEventValidator },
	handler: async (ctx, { userId, event }): Promise<DeliveryPlan> =>
		await planEvent(ctx, userId, event),
});

/**
 * "Send test alert" on the Deliverability Center: the alert test push for each
 * of the caller's devices, through the same plan as any push (current member,
 * push configured), so the test proves what a real alert would do.
 */
export const planAlertTestDelivery = internalQuery({
	args: { userId: v.string() },
	handler: async (ctx, { userId }): Promise<DeliveryPlan> => {
		const devices = await ctx.db
			.query('pushSubscriptions')
			.withIndex('by_user', (q) => q.eq('userId', userId))
			.take(MAX_DEVICES_PER_USER);
		const plan: DeliveryPlan = { deliveries: [], held: [] };
		for (const device of devices) {
			const one = await planEvent(ctx, userId, {
				kind: 'test',
				subscriptionId: device._id,
				isDeliverabilityAlert: true,
			});
			plan.deliveries.push(...one.deliveries);
		}
		return plan;
	},
});

/**
 * A notice about a deliverability alert counts its pushes on the alert, so the
 * Deliverability Center can say whether the alert reached anyone off the mail
 * path. A push service that dropped the device (`gone`) or refused the
 * message counts as failed.
 */
async function tallyAlertPushes(
	ctx: MutationCtx,
	event: Infer<typeof pushEventValidator>,
	held: number,
	outcomes: Infer<typeof pushOutcomeValidator>[]
): Promise<void> {
	if (event.kind !== 'marketing') return;
	const notice = await ctx.db.get(event.noticeId);
	const countedOn = notice?.alertId ?? notice?.sendingHoldAlertId;
	if (!countedOn) return;
	const delivered = outcomes.filter((row) => row.outcome === 'delivered').length;
	await recordAlertPushOutcomes(ctx, countedOn, {
		delivered,
		failed: outcomes.length - delivered,
		held,
	});
}

/** The commit after the pushes: held devices counted, answers written back. */
export const recordDelivery = internalMutation({
	args: {
		userId: v.string(),
		// Absent on jobs a previous release queued.
		event: v.optional(pushEventValidator),
		held: v.array(
			v.object({ subscriptionId: v.id('pushSubscriptions'), isMarketing: v.boolean() })
		),
		outcomes: v.array(pushOutcomeValidator),
	},
	handler: async (ctx, { userId, event, held, outcomes }): Promise<void> => {
		await holdForQuietHours(ctx, userId, held);
		await applyPushOutcomes(ctx, outcomes);
		if (event) await tallyAlertPushes(ctx, event, held.length, outcomes);
	},
});
