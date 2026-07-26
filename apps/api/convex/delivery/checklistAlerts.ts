'use node';

import { v } from 'convex/values';
import { components, internal } from '../_generated/api';
import { internalAction, type ActionCtx } from '../_generated/server';
import { getOptional } from '../lib/env';

const MAX_ALERT_RECIPIENTS = 20;
export const REGRESSION_EMAIL_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000] as const;

type RegressionEmailResult = {
	sent: boolean;
	reason?: 'not_pending' | 'no_admin_recipient' | 'retry_scheduled' | 'delivery_failed';
};

export function regressionEmailRetryDelay(attempt: number): number | null {
	return REGRESSION_EMAIL_RETRY_DELAYS_MS[attempt] ?? null;
}

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

async function scheduleTransientFailure(
	ctx: ActionCtx,
	args: { organizationId: string; identity: string },
	attempt: number
): Promise<RegressionEmailResult> {
	const delayMs = regressionEmailRetryDelay(attempt);
	if (delayMs !== null) {
		await ctx.scheduler.runAfter(
			delayMs,
			internal.delivery.checklistAlerts.deliverRegressionEmail,
			{
				...args,
				attempt: attempt + 1,
			}
		);
		return { sent: false, reason: 'retry_scheduled' };
	}
	await ctx.runMutation(internal.delivery.checklistAlertState.markEmailState, {
		...args,
		state: 'unavailable',
		now: Date.now(),
	});
	return { sent: false, reason: 'delivery_failed' };
}

type RegressionEmailArgs = {
	organizationId: string;
	identity: string;
	attempt?: number;
};

type RegressionEmailPayload = {
	to: string;
	from: string;
	subject: string;
	html: string;
};

export type RegressionEmailDependencies = {
	loadRecipients: (ctx: ActionCtx, organizationId: string) => Promise<string[]>;
	sendEmail: (ctx: ActionCtx, payload: RegressionEmailPayload) => Promise<unknown>;
};

const regressionEmailDependencies: RegressionEmailDependencies = {
	loadRecipients: adminEmails,
	sendEmail: (ctx, payload) => ctx.runAction(internal.systemMail.sendSystemEmail, payload),
};

export async function deliverRegressionEmailHandler(
	ctx: ActionCtx,
	args: RegressionEmailArgs,
	dependencies: RegressionEmailDependencies = regressionEmailDependencies
): Promise<RegressionEmailResult> {
	const attempt = Math.max(0, Math.trunc(args.attempt ?? 0));
	const alert = (await ctx.runQuery(internal.delivery.checklistAlertState.getPending, {
		organizationId: args.organizationId,
		identity: args.identity,
	})) as { message: string } | null;
	if (!alert) return { sent: false, reason: 'not_pending' };
	let recipients: string[];
	try {
		recipients = await dependencies.loadRecipients(ctx, args.organizationId);
	} catch {
		return scheduleTransientFailure(
			ctx,
			{ organizationId: args.organizationId, identity: args.identity },
			attempt
		);
	}
	const fromEmail =
		getOptional('DEFAULT_FROM_EMAIL') ??
		`noreply@${getOptional('DEFAULT_FROM_DOMAIN') ?? 'mail.owlat.app'}`;
	if (recipients.length === 0) {
		await ctx.runMutation(internal.delivery.checklistAlertState.markEmailState, {
			organizationId: args.organizationId,
			identity: args.identity,
			state: 'unavailable',
			now: Date.now(),
		});
		return { sent: false, reason: 'no_admin_recipient' };
	}
	const deliveries = await Promise.allSettled(
		recipients.map((to) =>
			dependencies.sendEmail(ctx, {
				to,
				from: `Owlat <${fromEmail}>`,
				subject: 'Owlat deliverability regression detected',
				html: `<p>Owlat detected that a previously verified deliverability check regressed.</p><p>${escapeHtml(alert.message)}</p><p>Open the Deliverability Center to review the live evidence and remediation guidance.</p>`,
			})
		)
	);
	if (!deliveries.some((delivery) => delivery.status === 'fulfilled')) {
		return scheduleTransientFailure(
			ctx,
			{ organizationId: args.organizationId, identity: args.identity },
			attempt
		);
	}
	await ctx.runMutation(internal.delivery.checklistAlertState.markEmailState, {
		organizationId: args.organizationId,
		identity: args.identity,
		state: 'sent',
		now: Date.now(),
	});
	return { sent: true };
}

export const deliverRegressionEmail = internalAction({
	args: {
		organizationId: v.string(),
		identity: v.string(),
		attempt: v.optional(v.number()),
	},
	handler: (ctx, args): Promise<RegressionEmailResult> => deliverRegressionEmailHandler(ctx, args),
});
