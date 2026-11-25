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
 * every subscribed webhook and the Center's channel summary hold for it. Each
 * raise writes a `sendingHoldAlerts` row that its channels report back to, and
 * the Center shows the one for the hold that stands.
 *
 * The Abuse status (module) calls `scheduleSendingHoldAlert` in the
 * transaction that flips sending between allowed and stopped, or moves a stop
 * between suspended and banned, so each real transition is announced once and
 * a same-state call announces nothing. A status change while stopped raises
 * the same `alertId` again with the new status and `previousHoldStatus`: the
 * people told "suspended" learn it is now "banned" (or the reverse), and one
 * resolve still closes the stretch. A reason or trigger changing under the
 * same status is not announced: what is stopped and who lifts it stay as the
 * last raise said. What the announcement says is fixed there, so a job that
 * runs after a later transition still reports its own. The webhook and the
 * email are separate jobs: neither can fail the transition or the other.
 *
 * Not called by the "Send test alert": its test payload is the alert shape
 * every receiver already routes, and a hold arrives in that same shape.
 */

import { v, type Infer } from 'convex/values';
import type { SendingHoldLift } from '@owlat/public-contract';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { internalQuery, type MutationCtx, type QueryCtx } from '../_generated/server';
import { readSuspensionLift } from '../analytics/reputationEvidence';
import { getOptional } from '../lib/env';
import { OWN_ARM_TRANSPORT_KIND } from '../lib/sendProviders/strategies/adaptive_mix';
import { internalMutation } from '../lib/writeFence';
import { enqueueSubscribedDeliveries } from '../webhooks/deliveryAttempts';
import { buildPayload } from '../webhooks/scheduleFanout';
import {
	sendingHoldStatusValidator,
	type SendingHoldStatus,
} from '../lib/validators/deliverability';
import { alertEmailCopy } from './alertEmailCopy';
import { alertChannelsView, type AlertChannelsView } from './checklistAlertChannelLedger';
import { publicSendingHoldLift } from './sendingHoldLift';

export const SENDING_HOLD_CHECK_ID = 'deployment.sending_hold';

const RAISED = 'deliverability.alert_raised' as const;
const RESOLVED = 'deliverability.alert_resolved' as const;

const holdStatusValidator = sendingHoldStatusValidator;
type HoldStatus = SendingHoldStatus;

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
		// A raise that changed the status of a hold that already stood.
		previousHoldStatus: v.optional(holdStatusValidator),
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

/** What the reader does: nothing when it lifts by itself, otherwise who lifts it. In English, for the webhook. */
export function sendingHoldNextAction(lift: SendingHoldLift): string {
	return alertEmailCopy('en').nextAction(lift);
}

/**
 * Announce a transition that stopped or resumed sending, or changed the
 * status of a stop. `before` is the settings row as the transition found it,
 * `after` with its patch applied. A resolve names the alert its raise named,
 * from when sending stopped; a stop recorded before that was kept falls back
 * to the status change time. Returns the record a raise's channels report
 * to, for the in-app notice the same transition schedules.
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
): Promise<Id<'sendingHoldAlerts'> | null> {
	const { before, after, at, reason } = change;
	let alert: SendingHoldAlert;
	let recordId: Id<'sendingHoldAlerts'> | null = null;
	if (isHold(after.abuseStatus)) {
		if (before.abuseStatus === after.abuseStatus) return null;
		const lift = publicSendingHoldLift(
			(await readSuspensionLift(ctx.db, after, at)) ?? { mode: 'admin' }
		);
		const previousHoldStatus = isHold(before.abuseStatus) ? before.abuseStatus : undefined;
		alert = {
			kind: 'raised',
			// A status change while stopped keeps the stretch's id.
			alertId: sendingHoldAlertId(after.sendingStoppedAt ?? before.abuseStatusChangedAt ?? at),
			holdStatus: after.abuseStatus,
			reason,
			lift: JSON.stringify(lift),
			nextAction: sendingHoldNextAction(lift),
			at,
			// System mail skips the suspension gate, but on the built-in MTA it
			// leaves from the server whose mail the suspension is about.
			emailMayNotArrive: getOptional('EMAIL_PROVIDER') === OWN_ARM_TRANSPORT_KIND,
			...(previousHoldStatus ? { previousHoldStatus } : {}),
		};
		recordId = await ctx.db.insert('sendingHoldAlerts', {
			alertId: alert.alertId,
			holdStatus: alert.holdStatus,
			...(previousHoldStatus ? { previousHoldStatus } : {}),
			reason,
			announcedAt: at,
			emailNotificationState: 'pending',
			emailAcceptedCount: 0,
			emailRetryingCount: 0,
			isEmailOnAffectedTransport: alert.emailMayNotArrive,
		});
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
		return null;
	}
	await ctx.scheduler.runAfter(0, internal.delivery.sendingHoldAlerts.announce, { alert });
	await ctx.scheduler.runAfter(0, internal.delivery.sendingHoldAlertEmail.deliver, { alert });
	return recordId;
}

/** The record of one raise; null for a resolve, or a raise a previous release queued. */
export async function findSendingHoldRecord(
	ctx: QueryCtx | MutationCtx,
	alert: SendingHoldAlert
): Promise<Doc<'sendingHoldAlerts'> | null> {
	if (alert.kind !== 'raised') return null;
	return await ctx.db
		.query('sendingHoldAlerts')
		.withIndex('by_alert_announced', (q) =>
			q.eq('alertId', alert.alertId).eq('announcedAt', alert.at)
		)
		.first();
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
				...(alert.previousHoldStatus ? { previousHoldStatus: alert.previousHoldStatus } : {}),
				lift: alert.lift,
			},
		});
		const deliveries = await enqueueSubscribedDeliveries(ctx, RAISED, payload);
		const record = await findSendingHoldRecord(ctx, alert);
		if (record) {
			await ctx.db.patch(record._id, {
				webhookDeliveryLogIds: deliveries.map((delivery) => delivery.logId),
			});
		}
		return { deliveries: deliveries.length };
	},
});

/**
 * What one email run did, written back to the raise's record: `accepted` and
 * `retrying` count this run's recipients, and a retry run settles the one
 * retry it was. The retries are scheduled here, with the count they change.
 */
export const recordEmailOutcome = internalMutation({
	args: {
		alert: sendingHoldAlertValidator,
		accepted: v.number(),
		retryUserIds: v.array(v.string()),
		/** The run's own attempt index; a retry run is `> 0`. */
		attempt: v.number(),
		retryDelayMs: v.union(v.number(), v.null()),
	},
	handler: async (ctx, args): Promise<void> => {
		const retryUserIds = args.retryDelayMs === null ? [] : args.retryUserIds;
		for (const userId of retryUserIds) {
			await ctx.scheduler.runAfter(
				args.retryDelayMs ?? 0,
				internal.delivery.sendingHoldAlertEmail.deliver,
				{ alert: args.alert, userId, attempt: args.attempt + 1 }
			);
		}
		const record = await findSendingHoldRecord(ctx, args.alert);
		if (!record) return;
		const accepted = record.emailAcceptedCount + args.accepted;
		const retrying = Math.max(
			0,
			record.emailRetryingCount - (args.attempt > 0 ? 1 : 0) + retryUserIds.length
		);
		await ctx.db.patch(record._id, {
			emailAcceptedCount: accepted,
			emailRetryingCount: retrying,
			emailNotificationState: accepted > 0 ? 'sent' : retrying > 0 ? 'pending' : 'unavailable',
		});
	},
});

/** The hold that stands, as the Deliverability Center lists it beside the regression alerts. */
export interface SendingHoldCenterAlert {
	alertId: string;
	holdStatus: HoldStatus;
	previousHoldStatus: HoldStatus | null;
	reason: string;
	observedAt: number;
	channels: AlertChannelsView;
}

/**
 * The latest raise of the hold that stands, or null while sending is allowed.
 * A hold that stopped before these records existed has none and is not listed:
 * Delivery health still shows it.
 */
export async function readStandingSendingHold(
	ctx: QueryCtx,
	settings: Doc<'instanceSettings'> | null
): Promise<SendingHoldCenterAlert | null> {
	if (!settings || !isHold(settings.abuseStatus) || settings.sendingStoppedAt === undefined) {
		return null;
	}
	const alertId = sendingHoldAlertId(settings.sendingStoppedAt);
	const record = await ctx.db
		.query('sendingHoldAlerts')
		.withIndex('by_alert_announced', (q) => q.eq('alertId', alertId))
		.order('desc')
		.first();
	if (!record) return null;
	return {
		alertId,
		holdStatus: record.holdStatus,
		previousHoldStatus: record.previousHoldStatus ?? null,
		reason: record.reason,
		observedAt: record.announcedAt,
		channels: await alertChannelsView(ctx, record),
	};
}

/**
 * Whether an announcement still describes sending as it is, for an email
 * retry: a suspension email is not resent after sending resumed or became a
 * ban, nor a resume email after sending stopped again.
 */
export const isAlertCurrent = internalQuery({
	args: { alert: sendingHoldAlertValidator },
	handler: async (ctx, { alert }): Promise<boolean> => {
		const settings = await ctx.db.query('instanceSettings').first();
		if (alert.kind === 'resolved') return !isHold(settings?.abuseStatus);
		// The status change this raise announced is still the latest: after
		// suspended, banned, suspended again, the first raise is stale.
		return (
			settings?.abuseStatus === alert.holdStatus &&
			settings.abuseStatusChangedAt === alert.at &&
			settings.sendingStoppedAt !== undefined &&
			sendingHoldAlertId(settings.sendingStoppedAt) === alert.alertId
		);
	},
});
