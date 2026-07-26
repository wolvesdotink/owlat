'use node';

import { createHash } from 'node:crypto';
import { v } from 'convex/values';
import {
	DELIVERABILITY_ALERT_RECIPIENT_LIMIT,
	type DeliverabilityAlertAdminRecipient,
} from '@owlat/shared';
import { components, internal } from '../_generated/api';
import { internalAction, type ActionCtx } from '../_generated/server';
import { getOptional } from '../lib/env';

export const REGRESSION_EMAIL_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000] as const;

type RegressionEmailResult = {
	sent: boolean;
	reason?:
		| 'not_pending'
		| 'no_admin_recipient'
		| 'delivery_in_progress'
		| 'retry_scheduled'
		| 'delivery_failed';
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

function normalizedEmail(value: string | undefined): string | undefined {
	const email = value?.trim().toLowerCase();
	return email || undefined;
}

async function adminRecipients(
	ctx: ActionCtx,
	organizationId: string
): Promise<DeliverabilityAlertAdminRecipient[]> {
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
						numItems: DELIVERABILITY_ALERT_RECIPIENT_LIMIT,
					},
				}) as Promise<{
					page?: Array<{ userId: string; role: string }>;
				} | null>
		)
	);
	const userIds = [
		...new Set(results.flatMap((result) => result?.page ?? []).map((member) => member.userId)),
	]
		.sort()
		.slice(0, DELIVERABILITY_ALERT_RECIPIENT_LIMIT);
	const users = await Promise.all(
		userIds.map(
			(userId) =>
				ctx.runQuery(components.betterAuth.adapter.findOne, {
					model: 'user',
					where: [{ field: '_id', value: userId }],
				}) as Promise<{ email?: string } | null>
		)
	);
	return userIds.map((userId, index) => {
		const email = normalizedEmail(users[index]?.email);
		return { userId, ...(email ? { email } : {}) };
	});
}

type RegressionEmailArgs = {
	organizationId: string;
	identity: string;
};

type RegressionEmailPayload = {
	to: string;
	from: string;
	subject: string;
	html: string;
	idempotencyKey: string;
};

export type RegressionEmailDependencies = {
	loadRecipients: (
		ctx: ActionCtx,
		organizationId: string
	) => Promise<DeliverabilityAlertAdminRecipient[]>;
	sendEmail: (ctx: ActionCtx, payload: RegressionEmailPayload) => Promise<unknown>;
	now: () => number;
	randomId: () => string;
};

const regressionEmailDependencies: RegressionEmailDependencies = {
	loadRecipients: adminRecipients,
	sendEmail: (ctx, payload) => ctx.runAction(internal.systemMail.sendSystemEmail, payload),
	now: Date.now,
	randomId: crypto.randomUUID,
};

function recipientIdempotencyKey(
	organizationId: string,
	identity: string,
	userId: string,
	email: string
): string {
	return `deliverability-alert-${createHash('sha256')
		.update(
			`${organizationId.length}:${organizationId}|${identity.length}:${identity}|${userId.length}:${userId}|${email}`
		)
		.digest('hex')}`;
}

function retryAtForFailure(attemptCount: number, now: number, error: unknown): number | undefined {
	const code = error instanceof Error ? /\(([A-Z_]+)\):/.exec(error.message)?.[1] : undefined;
	if (code !== 'RATE_LIMIT' && code !== 'SERVER_ERROR') return undefined;
	const delay = regressionEmailRetryDelay(attemptCount - 1);
	return delay === null ? undefined : now + delay;
}

export async function deliverRegressionEmailHandler(
	ctx: ActionCtx,
	args: RegressionEmailArgs,
	dependencies: RegressionEmailDependencies = regressionEmailDependencies
): Promise<RegressionEmailResult> {
	const alert = (await ctx.runQuery(internal.delivery.checklistAlertState.getPending, {
		organizationId: args.organizationId,
		identity: args.identity,
	})) as { emailDirectoryAttemptCount?: number } | null;
	if (!alert) return { sent: false, reason: 'not_pending' };

	let currentRecipients: DeliverabilityAlertAdminRecipient[];
	try {
		currentRecipients = await dependencies.loadRecipients(ctx, args.organizationId);
	} catch {
		const now = dependencies.now();
		const delay = regressionEmailRetryDelay(alert.emailDirectoryAttemptCount ?? 0);
		const deferred = await ctx.runMutation(
			internal.delivery.checklistAlertState.deferRecipientDirectory,
			{
				organizationId: args.organizationId,
				identity: args.identity,
				now,
				...(delay === null ? {} : { retryAt: now + delay }),
			}
		);
		return deferred.retryScheduled
			? { sent: false, reason: 'retry_scheduled' }
			: { sent: deferred.state === 'sent', reason: 'delivery_failed' };
	}

	const attemptToken = dependencies.randomId();
	const prepared = await ctx.runMutation(
		internal.delivery.checklistAlertState.prepareRecipientAttempts,
		{
			organizationId: args.organizationId,
			identity: args.identity,
			recipients: currentRecipients,
			attemptToken,
			now: dependencies.now(),
		}
	);
	if (!prepared) return { sent: false, reason: 'not_pending' };
	if (prepared.claims.length === 0) {
		if (prepared.state === 'sent') return { sent: true };
		return {
			sent: false,
			reason: prepared.state === 'pending' ? 'delivery_in_progress' : 'no_admin_recipient',
		};
	}

	const fromEmail =
		getOptional('DEFAULT_FROM_EMAIL') ??
		`noreply@${getOptional('DEFAULT_FROM_DOMAIN') ?? 'mail.owlat.app'}`;
	const deliveries = await Promise.allSettled(
		prepared.claims.map((claim) =>
			dependencies.sendEmail(ctx, {
				to: claim.email,
				from: `Owlat <${fromEmail}>`,
				subject: 'Owlat deliverability regression detected',
				html: `<p>Owlat detected that a previously verified deliverability check regressed.</p><p>${escapeHtml(prepared.message)}</p><p>Open the Deliverability Center to review the live evidence and remediation guidance.</p>`,
				idempotencyKey: recipientIdempotencyKey(
					args.organizationId,
					args.identity,
					claim.userId,
					claim.email
				),
			})
		)
	);
	const completedAt = dependencies.now();
	const results = prepared.claims.map((claim, index) => {
		const delivery = deliveries[index]!;
		const isSuccess = delivery.status === 'fulfilled';
		const retryAt = isSuccess
			? undefined
			: retryAtForFailure(claim.attemptCount, completedAt, delivery.reason);
		return {
			userId: claim.userId,
			isSuccess,
			...(retryAt === undefined ? {} : { retryAt }),
		};
	});
	const completion = await ctx.runMutation(
		internal.delivery.checklistAlertState.completeRecipientAttempts,
		{
			organizationId: args.organizationId,
			identity: args.identity,
			attemptToken,
			results,
			now: completedAt,
		}
	);
	const sent = results.some((result) => result.isSuccess) || completion.state === 'sent';
	if (completion.retryScheduled) return { sent, reason: 'retry_scheduled' };
	return completion.state === 'sent' ? { sent: true } : { sent: false, reason: 'delivery_failed' };
}

export const deliverRegressionEmail = internalAction({
	args: {
		organizationId: v.string(),
		identity: v.string(),
	},
	handler: (ctx, args): Promise<RegressionEmailResult> => deliverRegressionEmailHandler(ctx, args),
});
