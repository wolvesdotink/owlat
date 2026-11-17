/**
 * Which channels carried a deliverability regression alert, and what each did.
 *
 * The email is one channel, and it leaves through the mail path the alert may
 * be about. The others (the in-app notice and Web Push, written by the
 * marketing notice fan-out) do not, so the alert row keeps their outcome next
 * to the email state and the Deliverability Center shows all of them: an
 * operator reading "Email sent" for "port 25 is blocked" needs to know that
 * "sent" only means the blocked transport accepted it.
 *
 * Not a Convex function module; the fan-out, the push commit, the evidence
 * writer and the Center's reader import it.
 */

import { getOptional } from '../lib/env';
import { OWN_ARM_TRANSPORT_KIND } from '../lib/sendProviders/strategies/adaptive_mix';
import type { Doc, Id } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { webhookOutcome, type WebhookOutcome } from './checklistAlertWebhooks';
import { checklistTraits } from './checklistTraits';
import { DELIVERABILITY_CHECKLIST, type DeliverabilityCheckId } from '@owlat/shared';

type AlertId = Id<'deliverabilityRegressionAlerts'>;
export type AlertResolution = 'manual' | 'automatic';

/**
 * A blocking check of the server itself (reverse DNS, port 25, TLS,
 * blocklists) watches the transport the alert email leaves through when system
 * mail goes out over the built-in MTA. With another provider configured, the
 * email does not touch that server and its outcome means what it says.
 */
export function isEmailOnAffectedTransport(
	itemId: DeliverabilityCheckId,
	emailProvider: string | undefined = getOptional('EMAIL_PROVIDER')
): boolean {
	if (emailProvider !== OWN_ARM_TRANSPORT_KIND) return false;
	if (checklistTraits(itemId).scope !== 'deployment') return false;
	return DELIVERABILITY_CHECKLIST.find((item) => item.id === itemId)?.severity === 'blocking';
}

/**
 * Count the in-app notices one occurrence wrote. An alert can be announced by
 * two notices (raised as a warning, then a DNS failure on the same alert), so
 * the larger audience is kept rather than the sum, which would count a person
 * twice.
 */
export async function recordAlertInAppNotices(
	ctx: MutationCtx,
	alertId: AlertId,
	written: number
): Promise<void> {
	const alert = await ctx.db.get(alertId);
	if (!alert) return;
	await ctx.db.patch(alertId, {
		inAppNoticeCount: Math.max(alert.inAppNoticeCount ?? 0, written),
	});
}

export interface AlertPushTally {
	delivered: number;
	failed: number;
	held: number;
}

/** Add one person's push outcomes for an alert's notice. */
export async function recordAlertPushOutcomes(
	ctx: MutationCtx,
	alertId: AlertId,
	tally: AlertPushTally
): Promise<void> {
	if (tally.delivered + tally.failed + tally.held === 0) return;
	const alert = await ctx.db.get(alertId);
	if (!alert) return;
	await ctx.db.patch(alertId, {
		pushDeliveredCount: (alert.pushDeliveredCount ?? 0) + tally.delivered,
		pushFailedCount: (alert.pushFailedCount ?? 0) + tally.failed,
		pushHeldCount: (alert.pushHeldCount ?? 0) + tally.held,
	});
}

/** What the Deliverability Center shows per alert about its channels. */
export interface AlertChannelsView {
	email: {
		state: Doc<'deliverabilityRegressionAlerts'>['emailNotificationState'];
		isOnAffectedTransport: boolean;
	};
	/** People the in-app notice was written for; null when none was attempted yet. */
	inAppCount: number | null;
	push: AlertPushTally;
	/** The alert webhook deliveries; null before the announcement ran. */
	webhook: WebhookOutcome | null;
}

export async function alertChannelsView(
	ctx: QueryCtx,
	alert: Doc<'deliverabilityRegressionAlerts'>
): Promise<AlertChannelsView> {
	return {
		email: {
			state: alert.emailNotificationState,
			isOnAffectedTransport: alert.isEmailOnAffectedTransport === true,
		},
		inAppCount: alert.inAppNoticeCount ?? null,
		push: {
			delivered: alert.pushDeliveredCount ?? 0,
			failed: alert.pushFailedCount ?? 0,
			held: alert.pushHeldCount ?? 0,
		},
		webhook: alert.webhookDeliveryLogIds
			? await webhookOutcome(ctx, alert.webhookDeliveryLogIds)
			: null,
	};
}

/** Queue the webhook announcement of an alert being raised or closed. */
export async function scheduleAlertWebhook(
	ctx: MutationCtx,
	alertId: AlertId,
	change: { kind: 'raised' } | { kind: 'resolved'; resolution: AlertResolution }
): Promise<void> {
	await ctx.scheduler.runAfter(0, internal.delivery.checklistAlertWebhooks.announce, {
		alertId,
		...change,
	});
}
