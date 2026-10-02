'use node';

/**
 * Web Push sender: the network half of `push/dispatch.ts`.
 *
 * Each job asks dispatch which devices to push and what to say, encrypts one
 * message per device (lib/webPush.ts), posts it to that device's push service
 * and writes back what the service answered. A device's endpoint is a URL the
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
import { internalAction, type ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import { fetchGuarded } from '../lib/ssrfGuard';
import { logWarn } from '../lib/runtimeLog';
import { pushEventValidator } from '../lib/validators/push';
import { buildPushRequest, classifyPushResponse, type PushOutcome } from '../lib/webPush';
import { readVapidKeys } from './config';
import type { PushDelivery } from './dispatch';

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

async function pushAll(ctx: ActionCtx, deliveries: PushDelivery[]): Promise<void> {
	if (deliveries.length === 0) return;
	const outcomes = await Promise.all(
		deliveries.map(async (delivery) => ({
			subscriptionId: delivery.subscriptionId,
			outcome: await pushOne(delivery),
		}))
	);
	await ctx.runMutation(internal.push.dispatch.recordOutcomes, { outcomes });
}

/** Push one event to every device of one person that should hear about it. */
export const deliver = internalAction({
	args: { userId: v.string(), event: pushEventValidator },
	handler: async (ctx, args) => {
		const deliveries: PushDelivery[] = await ctx.runMutation(
			internal.push.dispatch.prepareDelivery,
			args
		);
		await pushAll(ctx, deliveries);
	},
});

/** The end-of-quiet-hours roll-up for one device (scheduled by dispatch). */
export const deliverQuietSummary = internalAction({
	args: { subscriptionId: v.id('pushSubscriptions') },
	handler: async (ctx, args) => {
		const delivery: PushDelivery | null = await ctx.runMutation(
			internal.push.dispatch.takeQuietSummary,
			args
		);
		if (delivery) await pushAll(ctx, [delivery]);
	},
});
