/**
 * Deliverability alerts as outbound webhook events
 * (`deliverability.alert_raised`, `deliverability.alert_resolved`), for an
 * operator who routes them to an on-call tool or a chat. They ride the
 * customer webhook machinery (signing, retries, the guarded fetch, the
 * delivery log) and reach only webhooks whose event list names them.
 *
 * The producers (the evidence writer and the alert resolution) schedule
 * `announce` (`scheduleAlertWebhook` in `checklistAlertChannelLedger.ts`)
 * instead of enqueueing in their own transaction, so a webhook
 * problem can never fail the check that raised the alert. `announce` writes
 * the delivery rows and, for a raise, records their ids on the alert in the
 * same commit, which is how the Deliverability Center shows whether the
 * webhook got it.
 */

import { v } from 'convex/values';
import { DELIVERABILITY_CHECKLIST, DELIVERABILITY_NEXT_ACTIONS } from '@owlat/shared';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { isFeatureEnabled } from '../lib/featureFlags';
import { internalMutation } from '../lib/writeFence';
import { enqueueSubscribedDeliveries } from '../webhooks/deliveryAttempts';
import { buildPayload } from '../webhooks/scheduleFanout';

type Alert = Doc<'deliverabilityRegressionAlerts'>;

const RAISED = 'deliverability.alert_raised' as const;
const RESOLVED = 'deliverability.alert_resolved' as const;

async function alertSubject(ctx: MutationCtx, alert: Alert) {
	const definition = DELIVERABILITY_CHECKLIST.find((item) => item.id === alert.itemId);
	const domain = alert.domainId ? await ctx.db.get(alert.domainId) : null;
	return {
		alertId: alert._id,
		checkId: alert.itemId,
		check: definition?.protocol ?? alert.itemId,
		// A removed sending domain leaves its alert behind; the alert still
		// says it was about a domain.
		domain: alert.domainId ? (domain?.domain ?? 'deleted sending domain') : null,
	};
}

export const announce = internalMutation({
	args: {
		alertId: v.id('deliverabilityRegressionAlerts'),
		kind: v.union(v.literal('raised'), v.literal('resolved')),
		resolution: v.optional(v.union(v.literal('manual'), v.literal('automatic'))),
	},
	handler: async (ctx, args): Promise<{ deliveries: number }> => {
		const alert = await ctx.db.get(args.alertId);
		if (!alert) return { deliveries: 0 };
		const subject = await alertSubject(ctx, alert);
		if (args.kind === 'resolved') {
			const payload = buildPayload({
				literal: RESOLVED,
				input: {
					...subject,
					resolvedAt: alert.resolvedAt ?? Date.now(),
					resolution: args.resolution ?? 'automatic',
				},
			});
			return { deliveries: (await enqueueSubscribedDeliveries(ctx, RESOLVED, payload)).length };
		}
		const definition = DELIVERABILITY_CHECKLIST.find((item) => item.id === alert.itemId);
		const payload = buildPayload({
			literal: RAISED,
			input: {
				...subject,
				severity: definition?.severity ?? 'blocking',
				message: alert.message,
				nextAction: DELIVERABILITY_NEXT_ACTIONS[alert.itemId],
				observedAt: alert.observedAt,
				emailMayNotArrive: alert.isEmailOnAffectedTransport === true,
				isTest: false,
			},
		});
		const deliveries = await enqueueSubscribedDeliveries(ctx, RAISED, payload);
		await ctx.db.patch(alert._id, {
			webhookDeliveryLogIds: deliveries.map((delivery) => delivery.logId),
		});
		return { deliveries: deliveries.length };
	},
});

/**
 * "Send test alert": a `deliverability.alert_raised` marked `isTest` to every
 * subscribed webhook, so the receiver's routing can be tried before it is
 * needed. Returns the delivery rows, whose outcome the test panel follows.
 */
export async function enqueueTestAlertWebhooks(
	ctx: MutationCtx,
	now: number
): Promise<Id<'webhookDeliveryLogs'>[]> {
	const payload = buildPayload({
		literal: RAISED,
		input: {
			alertId: 'test',
			checkId: 'test',
			check: 'Test alert',
			severity: 'blocking',
			domain: null,
			message: 'This is a test deliverability alert from Owlat. No check regressed.',
			nextAction: 'Nothing to fix. Check that this alert reached the right place.',
			observedAt: now,
			emailMayNotArrive: false,
			isTest: true,
		},
	});
	return (await enqueueSubscribedDeliveries(ctx, RAISED, payload)).map(
		(delivery) => delivery.logId
	);
}

export interface WebhookOutcome {
	delivered: number;
	failed: number;
	pending: number;
}

/** What the delivery rows say now; a row the log retention removed counts for nothing. */
export async function webhookOutcome(
	ctx: QueryCtx,
	logIds: readonly Id<'webhookDeliveryLogs'>[]
): Promise<WebhookOutcome> {
	const outcome: WebhookOutcome = { delivered: 0, failed: 0, pending: 0 };
	for (const logId of logIds) {
		const log = await ctx.db.get(logId);
		if (!log) continue;
		if (log.status === 'success') outcome.delivered += 1;
		else if (log.status === 'failed') outcome.failed += 1;
		else outcome.pending += 1;
	}
	return outcome;
}

/** Active webhooks that would receive a raised alert now. */
export async function subscribedAlertWebhookCount(
	ctx: QueryCtx
): Promise<{ isFeatureOn: boolean; count: number }> {
	if (!(await isFeatureEnabled(ctx, 'webhooks'))) return { isFeatureOn: false, count: 0 };
	const webhooks = await ctx.db
		.query('webhooks')
		.withIndex('by_active', (q) => q.eq('isActive', true))
		.collect(); // bounded: active webhooks (org-scale config)
	return {
		isFeatureOn: true,
		count: webhooks.filter((webhook) => webhook.events.includes(RAISED)).length,
	};
}
