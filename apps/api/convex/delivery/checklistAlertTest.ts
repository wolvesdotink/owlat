/**
 * "Send test alert" on the Deliverability Center: one test through every
 * channel a deliverability alert uses, with the result of each, so an admin
 * knows the alert would reach them before it has to.
 *
 * The email and push go to the admin who asked (a drill should not page the
 * whole team); the webhook goes to every webhook subscribed to deliverability
 * alerts, marked `isTest`, because that endpoint is the operator's on-call
 * route and is what needs proving. The webhook outcome arrives after the
 * action returns: the panel follows its delivery rows (`getTestWebhookResults`).
 */

import { v } from 'convex/values';
import { components, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { internalQuery } from '../_generated/server';
import { adminQuery, authedAction } from '../lib/authedFunctions';
import { isFeatureEnabled } from '../lib/featureFlags';
import { requireOrgPermission } from '../lib/sessionOrganization';
import { systemSenderAddress } from '../lib/systemSender';
import { internalMutation } from '../lib/writeFence';
import { isPreferenceOn } from '../marketing/noticePolicy';
import { isWebPushConfigured } from '../push/config';
import { enqueueTestAlertWebhooks, webhookOutcome } from './checklistAlertWebhooks';

/** Who asked, and what each channel can do for them now. */
export const prepare = internalQuery({
	args: {},
	handler: async (ctx) => {
		const session = await requireOrgPermission(ctx, 'organization:manage');
		const [user, switches, device] = await Promise.all([
			ctx.runQuery(components.betterAuth.adapter.findOne, {
				model: 'user',
				where: [{ field: '_id', value: session.userId }],
			}) as Promise<{ email?: string } | null>,
			ctx.db
				.query('marketingNotificationSettings')
				.withIndex('by_user', (q) => q.eq('userId', session.userId))
				.first(),
			ctx.db
				.query('pushSubscriptions')
				.withIndex('by_user', (q) => q.eq('userId', session.userId))
				.first(),
		]);
		return {
			userId: session.userId,
			email: user?.email?.trim() || null,
			isSwitchOn: isPreferenceOn(switches, 'deliverabilityAlerts'),
			hasDevice: device !== null,
		};
	},
});

/** The action's one commit: the test deliveries to the subscribed webhooks. */
export const enqueueTestWebhooks = internalMutation({
	args: {},
	handler: async (ctx): Promise<{ isFeatureOn: boolean; logIds: Id<'webhookDeliveryLogs'>[] }> => {
		if (!(await isFeatureEnabled(ctx, 'webhooks'))) return { isFeatureOn: false, logIds: [] };
		return { isFeatureOn: true, logIds: await enqueueTestAlertWebhooks(ctx, Date.now()) };
	},
});

type EmailResult =
	| { status: 'accepted'; to: string }
	| { status: 'failed'; error: string }
	| { status: 'skipped'; reason: 'no_sender' | 'no_address' };
type PushResult =
	| { status: 'sent'; delivered: number; failed: number }
	| { status: 'skipped'; reason: 'not_configured' | 'no_device' | 'switched_off' };
type WebhookResult =
	| { status: 'queued'; logIds: Id<'webhookDeliveryLogs'>[] }
	| { status: 'skipped'; reason: 'not_set' | 'webhooks_off' };

export interface TestAlertResult {
	email: EmailResult;
	inApp: { isSwitchOn: boolean };
	push: PushResult;
	webhook: WebhookResult;
}

const TEST_EMAIL_HTML =
	'<p>This is a test deliverability alert from Owlat. No check regressed.</p><p>A real alert also shows in the app, goes out as a push notification to admins who have push turned on, and reaches any webhook subscribed to deliverability alerts.</p>';

// authz: admin-gated — `prepare` requires `organization:manage` before any
// channel is touched.
export const sendTestAlert = authedAction({
	args: {},
	handler: async (ctx): Promise<TestAlertResult> => {
		const caller = await ctx.runQuery(internal.delivery.checklistAlertTest.prepare, {});

		const from = systemSenderAddress();
		let email: EmailResult;
		if (!from) email = { status: 'skipped', reason: 'no_sender' };
		else if (!caller.email) email = { status: 'skipped', reason: 'no_address' };
		else {
			const outcome = await ctx.runAction(internal.maintenance.systemMail.trySendSystemEmail, {
				to: caller.email,
				from: `Owlat <${from}>`,
				subject: 'Owlat test deliverability alert',
				html: TEST_EMAIL_HTML,
			});
			email =
				outcome.status === 'accepted'
					? { status: 'accepted', to: caller.email }
					: { status: 'failed', error: outcome.errorMessage };
		}

		let push: PushResult;
		if (!isWebPushConfigured()) push = { status: 'skipped', reason: 'not_configured' };
		else if (!caller.isSwitchOn) push = { status: 'skipped', reason: 'switched_off' };
		else if (!caller.hasDevice) push = { status: 'skipped', reason: 'no_device' };
		else {
			const sent = await ctx.runAction(internal.push.send.deliverAlertTest, {
				userId: caller.userId,
			});
			push = { status: 'sent', ...sent };
		}

		const queued = await ctx.runMutation(
			internal.delivery.checklistAlertTest.enqueueTestWebhooks,
			{}
		);
		const webhook: WebhookResult = !queued.isFeatureOn
			? { status: 'skipped', reason: 'webhooks_off' }
			: queued.logIds.length === 0
				? { status: 'skipped', reason: 'not_set' }
				: { status: 'queued', logIds: queued.logIds };

		return { email, inApp: { isSwitchOn: caller.isSwitchOn }, push, webhook };
	},
});

/** Where the test webhook deliveries stand, for the panel that follows them. */
export const getTestWebhookResults = adminQuery({
	args: { logIds: v.array(v.id('webhookDeliveryLogs')) },
	handler: async (ctx, args) => await webhookOutcome(ctx, args.logIds.slice(0, 50)),
});
