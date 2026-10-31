'use node';

/**
 * Web Push sender: the network half of `push/dispatch.ts`.
 *
 * Each job asks dispatch which devices to push and what to say, encrypts one
 * message per device (lib/webPush.ts), posts it to that device's push service
 * and writes back what the service answered, in one commit with the devices
 * quiet hours held the event back on (`push/delivery.ts`). A device's endpoint is a URL the
 * browser handed out, which means a URL a signed-in user could have made up, so
 * every request goes through the SSRF guard (https only, public addresses only,
 * no redirects) with a short timeout.
 *
 * Nothing here retries: a push that fails transiently is simply missed, which
 * is how every mail client's notifications behave — the mail itself is still
 * in the inbox. Endpoints never reach the log (they are bearer capabilities);
 * only the push service's host does.
 */

import { v } from 'convex/values';
import { internalAction } from '../_generated/server';
import { internal } from '../_generated/api';
import { fetchGuarded } from '../lib/ssrfGuard';
import { logWarn } from '../lib/runtimeLog';
import { pushEventValidator } from '../lib/validators/push';
import { buildPushRequest, classifyPushResponse, type PushOutcome } from '../lib/webPush';
import type { Id } from '../_generated/dataModel';
import { readVapidKeys } from './config';
import type { DeliveryPlan, PushDelivery } from './dispatch';

type PushOutcomeRow = { subscriptionId: Id<'pushSubscriptions'>; outcome: PushOutcome };

/** A push service answers in well under a second; never hold the action on a slow one. */
const PUSH_TIMEOUT_MS = 10_000;

function hostOf(endpoint: string): string {
	try {
		return new URL(endpoint).host;
	} catch {
		return 'invalid';
	}
}

/** Post one encrypted message and classify the answer; any thrown error is a transient failure. */
async function pushOne(delivery: PushDelivery): Promise<PushOutcome> {
	const keys = readVapidKeys();
	if (!keys) return 'failed';
	try {
		const request = await buildPushRequest(delivery, delivery.payload, keys, {
			ttlSeconds: delivery.ttlSeconds,
			// Every Owlat push is something a person should see now; `normal`
			// lets a dozing phone sit on it for minutes.
			urgency: 'high',
			topic: delivery.topic,
			nowMs: Date.now(),
		});
		const response = await fetchGuarded(request.endpoint, {
			method: 'POST',
			headers: request.headers,
			body: request.body,
			protocols: ['https:'],
			signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
		});
		const outcome = classifyPushResponse(response.status);
		if (outcome === 'rejected' || outcome === 'failed') {
			logWarn('[push] push service refused a message', {
				host: hostOf(delivery.endpoint),
				status: response.status,
			});
		}
		return outcome;
	} catch (error) {
		logWarn('[push] push request failed', {
			host: hostOf(delivery.endpoint),
			error: error instanceof Error ? error.name : 'unknown',
		});
		return 'failed';
	}
}

/** Push every delivery side by side; each answer is classified, none throws. */
async function pushAll(deliveries: PushDelivery[]): Promise<PushOutcomeRow[]> {
	return await Promise.all(
		deliveries.map(async (delivery) => ({
			subscriptionId: delivery.subscriptionId,
			outcome: await pushOne(delivery),
		}))
	);
}

/** Push one event to every device of one person that should hear about it. */
export const deliver = internalAction({
	args: { userId: v.string(), event: pushEventValidator },
	handler: async (ctx, args) => {
		const plan: DeliveryPlan = await ctx.runQuery(internal.push.delivery.planDelivery, args);
		const outcomes = await pushAll(plan.deliveries);
		if (outcomes.length === 0 && plan.held.length === 0) return;
		await ctx.runMutation(internal.push.delivery.recordDelivery, {
			userId: args.userId,
			held: plan.held,
			outcomes,
		});
	},
});

/** The end-of-quiet-hours roll-up for one device (scheduled by dispatch). */
export const deliverQuietSummary = internalAction({
	args: { subscriptionId: v.id('pushSubscriptions') },
	handler: async (ctx, args) => {
		// checkpoint: the held count is cleared before the push, so a retried job
		// cannot send the summary twice; a push that fails is missed, like any other.
		const delivery: PushDelivery | null = await ctx.runMutation(
			internal.push.dispatch.takeQuietSummary,
			args
		);
		if (!delivery) return;
		const outcomes = await pushAll([delivery]);
		await ctx.runMutation(internal.push.dispatch.recordOutcomes, { outcomes });
	},
});
