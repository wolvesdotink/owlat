'use node';

/**
 * The alert email for sending stopping or resuming (`sendingHoldAlerts.ts`):
 * the regression alert email's audience (every owner and admin, whatever
 * their "Deliverability alerts" switch, which governs the in-app notice and
 * push), sender, retry delays and retry rules.
 *
 * System mail does not pass the suspension gate (`maintenance/systemMail.ts`
 * dispatches straight to the transport), so this email leaves a suspended
 * instance. Each recipient reads it in their own interface language
 * (`alertEmailCopy.ts`).
 *
 * Each recipient is tried once per announcement. A failure the transport
 * calls safe to retry is retried for that recipient alone, on the regression
 * email's delays, and only while the announcement still describes sending as
 * it is; the provider's idempotency key keeps a retry from mailing twice.
 * What each run did is written back to the raise's record, which the
 * Deliverability Center reads.
 */

import { createHash } from 'node:crypto';
import { v } from 'convex/values';
import {
	GOVERNED_MTA_MAX_MESSAGE_AGE_MS,
	type DeliverabilityAlertAdminRecipient,
} from '@owlat/shared';
import { escapeHtml } from '@owlat/shared/html';
import type { SendingHoldLift } from '@owlat/public-contract';
import { sendingHoldLiftSchema } from '@owlat/public-contract/schemas';
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
import { alertEmailCopy } from './alertEmailCopy';
import { loadDeliverabilityAlertAdminRecipients } from './checklistAlertAudience';
import { loadRecipientLocales, regressionEmailRetryDelay } from './checklistAlerts';
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
	/** Each recipient's interface language; one left out reads as English. */
	loadLocales: (ctx: ActionCtx, userIds: string[]) => Promise<Map<string, string>>;
	sendEmail: (ctx: ActionCtx, payload: MailPayload) => Promise<SystemMailAttemptOutcome>;
};

const dependencies: SendingHoldEmailDependencies = {
	loadRecipients: async (ctx) =>
		loadDeliverabilityAlertAdminRecipients(ctx, await getSingletonOrganizationId(ctx)),
	loadLocales: loadRecipientLocales,
	sendEmail: (ctx, payload) =>
		ctx.runAction(internal.maintenance.systemMail.trySendSystemEmail, payload),
};

/** Held marketing mail can be dropped once it has waited this many days (its delivery deadline). */
const HELD_MAIL_DAYS = GOVERNED_MTA_MAX_MESSAGE_AGE_MS / (24 * 60 * 60 * 1000);

/** The lift the announcement carries, as the webhook does; unreadable reads as "an admin lifts it". */
function parseLift(text: string): SendingHoldLift {
	try {
		return sendingHoldLiftSchema.parse(JSON.parse(text));
	} catch {
		return { mode: 'admin', condition: null };
	}
}

/**
 * Subject and body in the recipient's language; the stored reason is the only
 * text that is not ours, and it is quoted as recorded.
 */
export function sendingHoldEmail(
	alert: SendingHoldAlert,
	locale?: string
): { subject: string; html: string } {
	const copy = alertEmailCopy(locale);
	const reason = escapeHtml(alert.reason);
	if (alert.kind === 'raised') {
		const opening = alert.previousHoldStatus
			? copy.holdChangedLine(alert.previousHoldStatus, alert.holdStatus)
			: copy.holdIntro(alert.holdStatus, HELD_MAIL_DAYS);
		return {
			subject: alert.previousHoldStatus
				? copy.holdChangedSubject(alert.previousHoldStatus, alert.holdStatus)
				: copy.holdSubject(alert.holdStatus),
			html: `<p>${opening}</p><p>${copy.reasonLine(reason)}</p><p>${escapeHtml(copy.nextAction(parseLift(alert.lift)))}</p><p>${copy.holdOpen}</p><p>${copy.otherChannels}</p>`,
		};
	}
	const how =
		alert.resolution === 'automatic' ? copy.resumedAutomatic(reason) : copy.resumedManual(reason);
	return {
		subject: copy.resumedSubject,
		html: `<p>${how}</p><p>${copy.resumedContinue}</p><p>${copy.otherChannels}</p>`,
	};
}

/**
 * The provider's dedupe key. A status change while stopped shares the first
 * raise's `alertId` and kind, so it also names its status: without it the
 * provider would drop the "now banned" email as a repeat.
 */
function idempotencyKey(alert: SendingHoldAlert, userId: string): string {
	const announcement =
		alert.kind === 'raised' && alert.previousHoldStatus
			? `${alert.alertId}|${alert.kind}|${alert.holdStatus}`
			: `${alert.alertId}|${alert.kind}`;
	return `sending-hold-alert-${createHash('sha256').update(`${announcement}|${userId}`).digest('hex')}`;
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

/**
 * Write what this run did to the raise's record and schedule its retries, in
 * one commit: a run that ends before it leaves its recipients counted as
 * still sending, never as retried when no retry exists.
 */
async function commitOutcome(
	ctx: ActionCtx,
	args: DeliverArgs,
	accepted: number,
	retryUserIds: string[]
): Promise<{ accepted: number; retrying: number }> {
	const attemptIndex = args.attempt ?? 0;
	const retryDelayMs = regressionEmailRetryDelay(attemptIndex);
	await ctx.runMutation(internal.delivery.sendingHoldAlerts.recordEmailOutcome, {
		alert: args.alert,
		accepted,
		retryUserIds,
		attempt: attemptIndex,
		retryDelayMs,
	});
	return { accepted, retrying: retryDelayMs === null ? 0 : retryUserIds.length };
}

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
		return commitOutcome(ctx, args, 0, []);
	}
	const from = systemSenderAddress();
	if (!from) return commitOutcome(ctx, args, 0, []);
	const recipients = (await deps.loadRecipients(ctx)).filter(
		(recipient) => args.userId === undefined || recipient.userId === args.userId
	);
	// A failed lookup costs the recipients their language, never the email.
	const locales = await deps
		.loadLocales(
			ctx,
			recipients.map((recipient) => recipient.userId)
		)
		.catch(() => new Map<string, string>());
	const outcomes = await Promise.all(
		recipients.map(async (recipient) => {
			if (!recipient.email) return null;
			const outcome = await attempt(
				ctx,
				{
					to: recipient.email,
					from: `Owlat <${from}>`,
					...sendingHoldEmail(args.alert, locales.get(recipient.userId)),
					idempotencyKey: idempotencyKey(args.alert, recipient.userId),
				},
				deps
			);
			return { userId: recipient.userId, outcome };
		})
	);
	let accepted = 0;
	const retryUserIds: string[] = [];
	for (const entry of outcomes) {
		if (!entry) continue;
		if (entry.outcome.status === 'accepted') accepted += 1;
		else if (entry.outcome.retryDisposition === 'safe_to_retry') retryUserIds.push(entry.userId);
	}
	return commitOutcome(ctx, args, accepted, retryUserIds);
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
