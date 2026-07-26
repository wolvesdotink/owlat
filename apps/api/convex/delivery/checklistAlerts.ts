'use node';

import { v } from 'convex/values';
import { components, internal } from '../_generated/api';
import { internalAction, type ActionCtx } from '../_generated/server';
import { getOptional } from '../lib/env';

const MAX_ALERT_RECIPIENTS = 20;

type RegressionEmailResult = {
	sent: boolean;
	reason?: 'not_pending' | 'no_admin_recipient';
};

function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

async function adminEmails(ctx: ActionCtx, organizationId: string): Promise<string[]> {
	const results = await Promise.all(
		(['owner', 'admin'] as const).map(
			(role) =>
				ctx.runQuery(components.betterAuth.adapter.findMany, {
					model: 'member',
					where: [
						{ field: 'organizationId', value: organizationId },
						{ field: 'role', value: role },
					],
					paginationOpts: {
						cursor: null,
						numItems: MAX_ALERT_RECIPIENTS,
					},
				}) as Promise<{
					page?: Array<{ userId: string; role: string }>;
				} | null>
		)
	);
	const admins = results.flatMap((result) => result?.page ?? []).slice(0, MAX_ALERT_RECIPIENTS);
	const users = await Promise.all(
		admins.map(
			(member) =>
				ctx.runQuery(components.betterAuth.adapter.findOne, {
					model: 'user',
					where: [{ field: '_id', value: member.userId }],
				}) as Promise<{ email?: string } | null>
		)
	);
	return [
		...new Set(
			users
				.map((user) => user?.email?.trim().toLowerCase())
				.filter((email): email is string => Boolean(email))
		),
	];
}

export const deliverRegressionEmail = internalAction({
	args: { organizationId: v.string(), identity: v.string() },
	handler: async (ctx, args): Promise<RegressionEmailResult> => {
		const alert = (await ctx.runQuery(internal.delivery.checklistAlertState.getPending, args)) as {
			message: string;
		} | null;
		if (!alert) return { sent: false, reason: 'not_pending' as const };
		const recipients = await adminEmails(ctx, args.organizationId);
		const fromEmail =
			getOptional('DEFAULT_FROM_EMAIL') ??
			`noreply@${getOptional('DEFAULT_FROM_DOMAIN') ?? 'mail.owlat.app'}`;
		if (recipients.length === 0) {
			await ctx.runMutation(internal.delivery.checklistAlertState.markEmailState, {
				...args,
				state: 'unavailable',
				now: Date.now(),
			});
			return { sent: false, reason: 'no_admin_recipient' as const };
		}
		const deliveries: PromiseSettledResult<unknown>[] = await Promise.allSettled(
			recipients.map((to) =>
				ctx.runAction(internal.systemMail.sendSystemEmail, {
					to,
					from: `Owlat <${fromEmail}>`,
					subject: 'Owlat deliverability regression detected',
					html: `<p>Owlat detected that a previously verified deliverability check regressed.</p><p>${escapeHtml(alert.message)}</p><p>Open the Deliverability Center to review the live evidence and remediation guidance.</p>`,
				})
			)
		);
		const sent = deliveries.some((delivery) => delivery.status === 'fulfilled');
		await ctx.runMutation(internal.delivery.checklistAlertState.markEmailState, {
			...args,
			state: sent ? 'sent' : 'unavailable',
			now: Date.now(),
		});
		return { sent };
	},
});
