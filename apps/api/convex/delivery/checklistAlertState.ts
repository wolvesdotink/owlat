import { v } from 'convex/values';
import { DELIVERABILITY_ALERT_RECIPIENT_LIMIT } from '@owlat/shared';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { internalMutation, internalQuery, type MutationCtx } from '../_generated/server';
import {
	deliverabilityAlertNotificationPatch,
	toDeliverabilityAlertRecipientState,
} from './checklistAlertRecipients';
import {
	loadRecipientDocs,
	persistRecipientStates,
	reconcileRecipientStates,
	reserveCurrentRecipientCapacity,
	type RecipientEntry,
} from './checklistAlertRecipientPersistence';

export const ALERT_SEND_BOUNDARY_GRACE_MS = 5 * 60_000;

async function notificationAlert(ctx: MutationCtx, organizationId: string, identity: string) {
	const alert = await ctx.db
		.query('deliverabilityRegressionAlerts')
		.withIndex('by_org_identity', (q) =>
			q.eq('organizationId', organizationId).eq('identity', identity)
		)
		.unique();
	return alert?.emailNotificationState === 'pending' ? alert : null;
}

async function pendingAlert(ctx: MutationCtx, organizationId: string, identity: string) {
	const alert = await notificationAlert(ctx, organizationId, identity);
	return alert?.resolvedAt === undefined ? alert : null;
}

async function loadAlertRecipientEntries(
	ctx: MutationCtx,
	alertId: Id<'deliverabilityRegressionAlerts'>
): Promise<RecipientEntry[]> {
	return (await loadRecipientDocs(ctx, alertId)).map((document) => ({
		document,
		state: toDeliverabilityAlertRecipientState(document),
	}));
}

async function persistAlertRecipientNotificationState(
	ctx: MutationCtx,
	alert: Doc<'deliverabilityRegressionAlerts'>,
	entries: readonly RecipientEntry[]
) {
	const states = entries.map((entry) => entry.state);
	const notificationPatch = deliverabilityAlertNotificationPatch(
		states,
		alert.compactedRecipientOutcomes
	);
	await persistRecipientStates(ctx, alert, entries);
	await ctx.db.patch(alert._id, notificationPatch);
	return notificationPatch;
}

export const getPending = internalQuery({
	args: { organizationId: v.string(), identity: v.string() },
	handler: async (ctx, args) => {
		const alert = await ctx.db
			.query('deliverabilityRegressionAlerts')
			.withIndex('by_org_identity', (q) =>
				q.eq('organizationId', args.organizationId).eq('identity', args.identity)
			)
			.unique();
		return alert?.emailNotificationState === 'pending' && alert.resolvedAt === undefined
			? alert
			: null;
	},
});

export const prepareRecipientAttempts = internalMutation({
	args: {
		organizationId: v.string(),
		identity: v.string(),
		recipients: v.array(v.object({ userId: v.string(), email: v.optional(v.string()) })),
		attemptToken: v.string(),
		now: v.number(),
	},
	handler: async (ctx, args) => {
		const alert = await pendingAlert(ctx, args.organizationId, args.identity);
		if (!alert) return null;
		const recipients = args.recipients.slice(0, DELIVERABILITY_ALERT_RECIPIENT_LIMIT);
		const protectedReceipts = new Map<
			string,
			{ outcome: 'sent' | 'transport_outcome_unknown'; sentAt?: number }
		>();
		for (const recipient of recipients) {
			const receipt = await ctx.db
				.query('deliverabilityAlertRecipientReceipts')
				.withIndex('by_alert_and_user', (q) =>
					q.eq('alertId', alert._id).eq('userId', recipient.userId)
				)
				.unique();
			if (receipt) protectedReceipts.set(recipient.userId, receipt);
		}
		const existing = await reserveCurrentRecipientCapacity(
			ctx,
			alert,
			await loadRecipientDocs(ctx, alert._id),
			recipients
		);
		const entries = reconcileRecipientStates(
			existing.map((document) => ({
				document,
				state: toDeliverabilityAlertRecipientState(document),
			})),
			recipients,
			protectedReceipts
		);
		const states = entries.map((entry) => entry.state);
		const currentByUserId = new Map(recipients.map((recipient) => [recipient.userId, recipient]));
		const claims: Array<{ userId: string; email: string; attemptCount: number }> = [];
		for (const state of states) {
			const current = currentByUserId.get(state.userId);
			if (
				state.status !== 'pending' ||
				!current?.email ||
				(state.nextAttemptAt !== undefined && state.nextAttemptAt > args.now)
			) {
				continue;
			}
			state.status = 'sending';
			state.attemptCount += 1;
			state.attemptToken = args.attemptToken;
			state.attemptStartedAt = args.now;
			state.nextAttemptAt = undefined;
			claims.push({
				userId: state.userId,
				email: current.email,
				attemptCount: state.attemptCount,
			});
		}
		await persistRecipientStates(ctx, alert, entries);
		await ctx.db.patch(alert._id, {
			...deliverabilityAlertNotificationPatch(states, alert.compactedRecipientOutcomes),
			emailDirectoryAttemptCount: 0,
		});
		if (claims.length > 0) {
			await ctx.scheduler.runAt(
				args.now + ALERT_SEND_BOUNDARY_GRACE_MS,
				internal.delivery.checklistAlertState.expireRecipientAttempts,
				{
					organizationId: args.organizationId,
					identity: args.identity,
					attemptToken: args.attemptToken,
				}
			);
		}
		return {
			message: alert.message,
			claims,
			state: deliverabilityAlertNotificationPatch(states, alert.compactedRecipientOutcomes)
				.emailNotificationState,
		};
	},
});

export const completeRecipientAttempts = internalMutation({
	args: {
		organizationId: v.string(),
		identity: v.string(),
		attemptToken: v.string(),
		results: v.array(
			v.object({
				userId: v.string(),
				isSuccess: v.boolean(),
				retryAt: v.optional(v.number()),
			})
		),
		now: v.number(),
	},
	handler: async (ctx, args) => {
		const alert = await notificationAlert(ctx, args.organizationId, args.identity);
		if (!alert) return { state: 'not_pending' as const, retryScheduled: false };
		const entries = await loadAlertRecipientEntries(ctx, alert._id);
		const states = entries.map((entry) => entry.state);
		const resultByUserId = new Map(args.results.map((result) => [result.userId, result]));
		for (const state of states) {
			const result = resultByUserId.get(state.userId);
			if (!result || state.status !== 'sending' || state.attemptToken !== args.attemptToken) {
				continue;
			}
			state.attemptToken = undefined;
			state.attemptStartedAt = undefined;
			if (result.isSuccess) {
				state.status = 'sent';
				state.sentAt = args.now;
				state.nextAttemptAt = undefined;
				state.unavailableReason = undefined;
			} else if (result.retryAt !== undefined && alert.resolvedAt === undefined) {
				state.status = 'pending';
				state.nextAttemptAt = result.retryAt;
			} else {
				state.status = 'unavailable';
				state.nextAttemptAt = undefined;
				state.unavailableReason = 'delivery_failed';
			}
		}
		const earliestRetryAt = states.reduce<number | undefined>(
			(earliest, recipient) =>
				recipient.status === 'pending' && recipient.nextAttemptAt !== undefined
					? earliest === undefined
						? recipient.nextAttemptAt
						: Math.min(earliest, recipient.nextAttemptAt)
					: earliest,
			undefined
		);
		const notificationPatch = await persistAlertRecipientNotificationState(ctx, alert, entries);
		const state = notificationPatch.emailNotificationState;
		if (state === 'pending' && earliestRetryAt !== undefined) {
			await ctx.scheduler.runAt(
				earliestRetryAt,
				internal.delivery.checklistAlerts.deliverRegressionEmail,
				{ organizationId: args.organizationId, identity: args.identity }
			);
		}
		return { state, retryScheduled: earliestRetryAt !== undefined };
	},
});

export const expireRecipientAttempts = internalMutation({
	args: {
		organizationId: v.string(),
		identity: v.string(),
		attemptToken: v.string(),
	},
	handler: async (ctx, args) => {
		const alert = await notificationAlert(ctx, args.organizationId, args.identity);
		if (!alert) return { state: 'not_pending' as const, expired: 0 };
		const entries = await loadAlertRecipientEntries(ctx, alert._id);
		const states = entries.map((entry) => entry.state);
		let expired = 0;
		for (const state of states) {
			if (state.status !== 'sending' || state.attemptToken !== args.attemptToken) continue;
			expired += 1;
			state.status = 'unavailable';
			state.unavailableReason = 'transport_outcome_unknown';
			state.attemptToken = undefined;
			state.attemptStartedAt = undefined;
			state.nextAttemptAt = undefined;
		}
		const notificationPatch = await persistAlertRecipientNotificationState(ctx, alert, entries);
		return { state: notificationPatch.emailNotificationState, expired };
	},
});

export const deferRecipientDirectory = internalMutation({
	args: {
		organizationId: v.string(),
		identity: v.string(),
		now: v.number(),
		retryAt: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const alert = await pendingAlert(ctx, args.organizationId, args.identity);
		if (!alert) return { state: 'not_pending' as const, retryScheduled: false };
		const attemptCount = (alert.emailDirectoryAttemptCount ?? 0) + 1;
		if (args.retryAt !== undefined) {
			await ctx.db.patch(alert._id, { emailDirectoryAttemptCount: attemptCount });
			await ctx.scheduler.runAt(
				args.retryAt,
				internal.delivery.checklistAlerts.deliverRegressionEmail,
				{ organizationId: args.organizationId, identity: args.identity }
			);
			return { state: 'pending' as const, retryScheduled: true };
		}
		const entries = await loadAlertRecipientEntries(ctx, alert._id);
		for (const entry of entries) {
			if (entry.state.status !== 'pending') continue;
			entry.state = {
				...entry.state,
				status: 'unavailable',
				nextAttemptAt: undefined,
				unavailableReason: 'recipient_directory_unavailable',
			};
		}
		const notificationPatch = await persistAlertRecipientNotificationState(ctx, alert, entries);
		return {
			state: notificationPatch.emailNotificationState,
			retryScheduled: false,
		};
	},
});
