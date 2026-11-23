'use node';

/**
 * The alert email for sending stopping or resuming (`sendingHoldAlerts.ts`):
 * the regression alert email's audience (every owner and admin, whatever
 * their "Deliverability alerts" switch, which governs the in-app notice and
 * push), sender, retry delays and retry rules.
 *
 * System mail does not pass the suspension gate (`maintenance/systemMail.ts`
 * dispatches straight to the transport), so this email leaves a suspended
 * instance. English only, like every alert email.
 *
 * Each recipient is tried once per announcement. A failure the transport
 * calls safe to retry is retried for that recipient alone, on the regression
 * email's delays, and only while the announcement still describes sending as
 * it is; the provider's idempotency key keeps a retry from mailing twice.
 */

import { createHash } from 'node:crypto';
import { v } from 'convex/values';
import {
	GOVERNED_MTA_MAX_MESSAGE_AGE_MS,
	type DeliverabilityAlertAdminRecipient,
} from '@owlat/shared';
import { escapeHtml } from '@owlat/shared/html';
import { internal } from '../_generated/api';
import { internalAction, type ActionCtx } from '../_generated/server';
import { getOptional } from '../lib/env';
import { EmailErrorCode } from '../lib/sendProviders';
import { getSingletonOrganizationId } from '../lib/sessionOrganization';
import { systemSenderAddress } from '../lib/systemSender';
import {
	systemMailRetryDisposition,
	type SystemMailAttemptOutcome,
} from '../lib/systemMailOutcome';
import { loadDeliverabilityAlertAdminRecipients } from './checklistAlertAudience';
import { OTHER_CHANNELS_LINE, regressionEmailRetryDelay } from './checklistAlerts';
import { sendingHoldAlertValidator, type SendingHoldAlert } from './sendingHoldAlerts';

type MailPayload = {
	to: string;
	from: string;
	subject: string;
	html: string;
	idempotencyKey: string;
};

export type SendingHoldEmailDependencies = {
	loadRecipients: (ctx: ActionCtx) => Promise<DeliverabilityAlertAdminRecipient[]>;
	sendEmail: (ctx: ActionCtx, payload: MailPayload) => Promise<SystemMailAttemptOutcome>;
};

const dependencies: SendingHoldEmailDependencies = {
	loadRecipients: async (ctx) =>
		loadDeliverabilityAlertAdminRecipients(ctx, await getSingletonOrganizationId(ctx)),
	sendEmail: (ctx, payload) =>
		ctx.runAction(internal.maintenance.systemMail.trySendSystemEmail, payload),
};

/** Held marketing mail is dropped once it has waited this many days (its delivery deadline). */
const HELD_MAIL_DAYS = GOVERNED_MTA_MAX_MESSAGE_AGE_MS / (24 * 60 * 60 * 1000);

/** Subject and body; the stored reason is the only text that is not ours. */
export function sendingHoldEmail(alert: SendingHoldAlert): { subject: string; html: string } {
	const reason = escapeHtml(alert.reason);
	if (alert.kind === 'raised') {
		return {
			subject: `Owlat: sending is ${alert.holdStatus}`,
			html: `<p>Sending on your Owlat instance is ${alert.holdStatus}. Campaigns and automation emails wait, and new transactional sends are refused, until it lifts. Mail still waiting after ${HELD_MAIL_DAYS} days is not sent.</p><p>Reason: ${reason}</p><p>${escapeHtml(alert.nextAction)}</p><p>Open Delivery health in Owlat to see where the rates stand.</p><p>${OTHER_CHANNELS_LINE}</p>`,
		};
	}
	const how =
		alert.resolution === 'automatic'
			? `The reputation check lifted the suspension by itself: ${reason}`
			: `A platform admin lifted it: ${reason}`;
	return {
		subject: 'Owlat: sending resumed',
		html: `<p>Sending on your Owlat instance resumed. ${how}</p><p>Campaigns and automation emails that waited continue where they stopped, unless they waited ${HELD_MAIL_DAYS} days or more; nobody is mailed twice.</p><p>${OTHER_CHANNELS_LINE}</p>`,
	};
}

function idempotencyKey(alert: SendingHoldAlert, userId: string): string {
	return `sending-hold-alert-${createHash('sha256')
		.update(`${alert.alertId}|${alert.kind}|${userId}`)
		.digest('hex')}`;
}

async function attempt(
	ctx: ActionCtx,
	payload: MailPayload,
	deps: SendingHoldEmailDependencies
): Promise<SystemMailAttemptOutcome> {
	try {
		return await deps.sendEmail(ctx, payload);
	} catch (error) {
		return {
			status: 'failed',
			provider: null,
			errorCode: EmailErrorCode.AMBIGUOUS_TIMEOUT,
			errorMessage:
				error instanceof Error ? error.message : 'System mail action failed without a receipt',
			retryDisposition: systemMailRetryDisposition(
				getOptional('EMAIL_PROVIDER'),
				payload.idempotencyKey,
				EmailErrorCode.AMBIGUOUS_TIMEOUT
			),
		};
	}
}

type DeliverArgs = { alert: SendingHoldAlert; userId?: string; attempt?: number };

export async function deliverSendingHoldEmailHandler(
	ctx: ActionCtx,
	args: DeliverArgs,
	deps: SendingHoldEmailDependencies = dependencies
): Promise<{ accepted: number; retrying: number }> {
	const attemptIndex = args.attempt ?? 0;
	if (
		attemptIndex > 0 &&
		!(await ctx.runQuery(internal.delivery.sendingHoldAlerts.isAlertCurrent, {
			alert: args.alert,
		}))
	) {
		return { accepted: 0, retrying: 0 };
	}
	const from = systemSenderAddress();
	if (!from) return { accepted: 0, retrying: 0 };
	const recipients = (await deps.loadRecipients(ctx)).filter(
		(recipient) => args.userId === undefined || recipient.userId === args.userId
	);
	const { subject, html } = sendingHoldEmail(args.alert);
	const outcomes = await Promise.all(
		recipients.map(async (recipient) => {
			if (!recipient.email) return null;
			const outcome = await attempt(
				ctx,
				{
					to: recipient.email,
					from: `Owlat <${from}>`,
					subject,
					html,
					idempotencyKey: idempotencyKey(args.alert, recipient.userId),
				},
				deps
			);
			return { userId: recipient.userId, outcome };
		})
	);
	let accepted = 0;
	let retrying = 0;
	for (const entry of outcomes) {
		if (!entry) continue;
		if (entry.outcome.status === 'accepted') {
			accepted += 1;
			continue;
		}
		const delay = regressionEmailRetryDelay(attemptIndex);
		if (entry.outcome.retryDisposition !== 'safe_to_retry' || delay === null) continue;
		retrying += 1;
		await ctx.scheduler.runAfter(delay, internal.delivery.sendingHoldAlertEmail.deliver, {
			alert: args.alert,
			userId: entry.userId,
			attempt: attemptIndex + 1,
		});
	}
	return { accepted, retrying };
}

export const deliver = internalAction({
	args: {
		alert: sendingHoldAlertValidator,
		// A retry: the one recipient it is for, and how many attempts came before.
		userId: v.optional(v.string()),
		attempt: v.optional(v.number()),
	},
	handler: (ctx, args) => deliverSendingHoldEmailHandler(ctx, args),
});
