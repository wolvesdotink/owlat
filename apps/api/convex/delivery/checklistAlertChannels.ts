/**
 * Where deliverability alerts would go right now, for the channel summary on
 * the Deliverability Center ("Email to 2 people · Push on 1 device · Webhook
 * not set").
 *
 * The audience is the alert email's (`checklistAlertAudience.ts`); in-app and
 * push reach the part of it whose "Deliverability alerts" switch is on, and
 * push only their registered devices. The caller's own switch and devices come
 * back separately, so the summary can offer the one action that fixes each
 * channel for them.
 */

import { adminQuery } from '../lib/authedFunctions';
import type { QueryCtx } from '../_generated/server';
import { getOptional } from '../lib/env';
import { OWN_ARM_TRANSPORT_KIND } from '../lib/sendProviders/strategies/adaptive_mix';
import { systemSenderAddress } from '../lib/systemSender';
import { isPreferenceOn } from '../marketing/noticePolicy';
import { isWebPushConfigured } from '../push/config';
import { MAX_DEVICES_PER_USER } from '../push/dispatch';
import { loadDeliverabilityAlertAdminRecipients } from './checklistAlertAudience';
import { subscribedAlertWebhookCount } from './checklistAlertWebhooks';

interface RecipientReach {
	userId: string;
	hasEmail: boolean;
	isSwitchOn: boolean;
	deviceCount: number;
}

async function reachOf(
	ctx: QueryCtx,
	recipient: { userId: string; email?: string }
): Promise<RecipientReach> {
	const [switches, devices] = await Promise.all([
		ctx.db
			.query('marketingNotificationSettings')
			.withIndex('by_user', (q) => q.eq('userId', recipient.userId))
			.first(),
		ctx.db
			.query('pushSubscriptions')
			.withIndex('by_user', (q) => q.eq('userId', recipient.userId))
			.take(MAX_DEVICES_PER_USER),
	]);
	return {
		userId: recipient.userId,
		hasEmail: recipient.email !== undefined,
		isSwitchOn: isPreferenceOn(switches, 'deliverabilityAlerts'),
		deviceCount: devices.length,
	};
}

export const getChannels = adminQuery({
	args: {},
	handler: async (ctx, _args, session) => {
		const recipients = await loadDeliverabilityAlertAdminRecipients(
			ctx,
			session.activeOrganizationId
		);
		const reach = await Promise.all(recipients.map((recipient) => reachOf(ctx, recipient)));
		const listening = reach.filter((row) => row.isSwitchOn);
		const me = reach.find((row) => row.userId === session.userId);
		const isPushConfigured = isWebPushConfigured();
		return {
			email: {
				recipientCount: reach.filter((row) => row.hasEmail).length,
				isSenderConfigured: systemSenderAddress() !== null,
				isOnOwnMta: getOptional('EMAIL_PROVIDER') === OWN_ARM_TRANSPORT_KIND,
			},
			inApp: { recipientCount: listening.length },
			push: {
				isConfigured: isPushConfigured,
				deviceCount: isPushConfigured
					? listening.reduce((total, row) => total + row.deviceCount, 0)
					: 0,
			},
			webhook: await subscribedAlertWebhookCount(ctx),
			me: {
				isSwitchOn: me?.isSwitchOn ?? isPreferenceOn(null, 'deliverabilityAlerts'),
				deviceCount: me?.deviceCount ?? 0,
			},
		};
	},
});
