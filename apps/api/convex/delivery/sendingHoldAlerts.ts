/**
 * Sending stopping and resuming as a deliverability alert: the
 * `deliverability.alert_raised` and `deliverability.alert_resolved` webhook
 * events with `checkId` `deployment.sending_hold`, and the alert email to the
 * owners and admins (`sendingHoldAlertEmail.ts`). The in-app notice and the
 * push are the marketing notice the same transition schedules.
 *
 * A hold is not a `deliverabilityRegressionAlerts` row: that row is a
 * checklist check that regressed between two pieces of evidence, and a
 * suspension has neither. It shares the wire shape and the email audience, so
 * every subscribed webhook and the Center's channel summary hold for it.
 *
 * The Abuse status (module) calls `scheduleSendingHoldAlert` in the
 * transaction that flips sending between allowed and stopped, so each real
 * transition is announced once and a same-state call announces nothing. What
 * the announcement says is fixed there, so a job that runs after a later
 * transition still reports its own. The webhook and the email are separate
 * jobs: neither can fail the transition or the other.
 *
 * Not called by the "Send test alert": its test payload is the alert shape
 * every receiver already routes, and a hold arrives in that same shape.
 */

import { v, type Infer } from 'convex/values';
import type { SendingHoldLift } from '@owlat/public-contract';
import { internal } from '../_generated/api';
import type { Doc } from '../_generated/dataModel';
import { internalQuery, type MutationCtx } from '../_generated/server';
import { readSuspensionLift } from '../analytics/reputationEvidence';
import { getOptional } from '../lib/env';
import { OWN_ARM_TRANSPORT_KIND } from '../lib/sendProviders/strategies/adaptive_mix';
import { internalMutation } from '../lib/writeFence';
import { enqueueSubscribedDeliveries } from '../webhooks/deliveryAttempts';
import { buildPayload } from '../webhooks/scheduleFanout';
import { publicSendingHoldLift, sendingHoldLiftSentence } from './sendingHoldLift';

export const SENDING_HOLD_CHECK_ID = 'deployment.sending_hold';

const RAISED = 'deliverability.alert_raised' as const;
const RESOLVED = 'deliverability.alert_resolved' as const;

const holdStatusValidator = v.union(v.literal('suspended'), v.literal('banned'));
type HoldStatus = Infer<typeof holdStatusValidator>;

export const sendingHoldAlertValidator = v.union(
	v.object({
		kind: v.literal('raised'),
		alertId: v.string(),
		holdStatus: holdStatusValidator,
		reason: v.string(),
		/** The `SendingHoldLift` as JSON text, the form the flat event data carries. */
		lift: v.string(),
		nextAction: v.string(),
		at: v.number(),
		emailMayNotArrive: v.boolean(),
	}),
	v.object({
		kind: v.literal('resolved'),
		alertId: v.string(),
		holdStatus: holdStatusValidator,
		reason: v.string(),
		resolution: v.union(v.literal('manual'), v.literal('automatic')),
		at: v.number(),
	})
);
export type SendingHoldAlert = Infer<typeof sendingHoldAlertValidator>;

function isHold(status: Doc<'instanceSettings'>['abuseStatus']): status is HoldStatus {
	return status === 'suspended' || status === 'banned';
}

/** One id per stretch of stopped sending, from the moment it stopped; the resolve repeats it. */
export function sendingHoldAlertId(stoppedAt: number): string {
	return `sending_hold:${stoppedAt}`;
}

export function sendingHoldCheckLabel(status: HoldStatus): string {
	return status === 'banned' ? 'Sending banned' : 'Sending suspended';
}

/** What the reader does: nothing when it lifts by itself, otherwise who lifts it. */
export function sendingHoldNextAction(lift: SendingHoldLift): string {
	const sentence = sendingHoldLiftSentence(lift);
	return lift.mode === 'automatic'
		? `${sentence} Nothing to do unless you want sending back sooner: a platform admin can lift it in the Operator console.`
		: `${sentence} A platform admin lifts it in the Operator console.`;
}

/**
 * Announce a transition that stopped or resumed sending. `before` is the
 * settings row as the transition found it, `after` with its patch applied.
 * A resolve names the alert its raise named, from when sending stopped; a
 * stop recorded before that was kept falls back to the status change time.
 */
export async function scheduleSendingHoldAlert(
	ctx: MutationCtx,
	change: {
		before: Doc<'instanceSettings'>;
		after: Doc<'instanceSettings'>;
		at: number;
		reason: string;
		isPlatformAdmin: boolean;
	}
): Promise<void> {
	const { before, after, at, reason } = change;
	let alert: SendingHoldAlert;
	if (isHold(after.abuseStatus)) {
		const lift = publicSendingHoldLift(
			(await readSuspensionLift(ctx.db, after, at)) ?? { mode: 'admin' }
		);
		alert = {
			kind: 'raised',
			alertId: sendingHoldAlertId(at),
			holdStatus: after.abuseStatus,
			reason,
			lift: JSON.stringify(lift),
			nextAction: sendingHoldNextAction(lift),
			at,
			// System mail skips the suspension gate, but on the built-in MTA it
			// leaves from the server whose mail the suspension is about.
			emailMayNotArrive: getOptional('EMAIL_PROVIDER') === OWN_ARM_TRANSPORT_KIND,
		};
	} else if (isHold(before.abuseStatus)) {
		alert = {
			kind: 'resolved',
			alertId: sendingHoldAlertId(before.sendingStoppedAt ?? before.abuseStatusChangedAt ?? at),
			holdStatus: before.abuseStatus,
			reason,
			resolution: change.isPlatformAdmin ? 'manual' : 'automatic',
			at,
		};
	} else {
		return;
	}
	await ctx.scheduler.runAfter(0, internal.delivery.sendingHoldAlerts.announce, { alert });
	await ctx.scheduler.runAfter(0, internal.delivery.sendingHoldAlertEmail.deliver, { alert });
}

/** The webhook deliveries of one announcement, through the customer webhook machinery. */
export const announce = internalMutation({
	args: { alert: sendingHoldAlertValidator },
	handler: async (ctx, { alert }): Promise<{ deliveries: number }> => {
		const subject = {
			alertId: alert.alertId,
			checkId: SENDING_HOLD_CHECK_ID,
			check: sendingHoldCheckLabel(alert.holdStatus),
			domain: null,
		};
		if (alert.kind === 'resolved') {
			const payload = buildPayload({
				literal: RESOLVED,
				input: { ...subject, resolvedAt: alert.at, resolution: alert.resolution },
			});
			return { deliveries: (await enqueueSubscribedDeliveries(ctx, RESOLVED, payload)).length };
		}
		const payload = buildPayload({
			literal: RAISED,
			input: {
				...subject,
				severity: 'blocking',
				message: alert.reason,
				nextAction: alert.nextAction,
				observedAt: alert.at,
				emailMayNotArrive: alert.emailMayNotArrive,
				isTest: false,
				holdStatus: alert.holdStatus,
				lift: alert.lift,
			},
		});
		return { deliveries: (await enqueueSubscribedDeliveries(ctx, RAISED, payload)).length };
	},
});

/**
 * Whether an announcement still describes sending as it is, for an email
 * retry: a suspension email is not resent after sending resumed, nor a resume
 * email after sending stopped again.
 */
export const isAlertCurrent = internalQuery({
	args: { alert: sendingHoldAlertValidator },
	handler: async (ctx, { alert }): Promise<boolean> => {
		const settings = await ctx.db.query('instanceSettings').first();
		if (alert.kind === 'resolved') return !isHold(settings?.abuseStatus);
		return (
			isHold(settings?.abuseStatus) &&
			settings?.sendingStoppedAt !== undefined &&
			sendingHoldAlertId(settings.sendingStoppedAt) === alert.alertId
		);
	},
});
