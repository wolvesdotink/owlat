import { v } from 'convex/values';
import {
	DELIVERABILITY_ALERT_RECIPIENT_LIMIT,
	type DeliverabilityAlertAdminRecipient,
	type DeliverabilityAlertRecipientState,
} from '@owlat/shared';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { internalMutation, internalQuery, type MutationCtx } from '../_generated/server';
import {
	DELIVERABILITY_ALERT_RECIPIENT_COMPACTION_TARGET,
	DELIVERABILITY_ALERT_RECIPIENT_ROW_LIMIT,
	boundedDeliverabilityAlertRecipientRows,
	cancelledDeliverabilityAlertRecipientPatch,
	deliverabilityAlertNotificationPatch,
	toDeliverabilityAlertRecipientState,
} from './checklistAlertRecipients';

export const ALERT_SEND_BOUNDARY_GRACE_MS = 5 * 60_000;

type RecipientDoc = Doc<'deliverabilityAlertRecipients'>;
type RecipientEntry = {
	document?: RecipientDoc;
	state: DeliverabilityAlertRecipientState;
};

function recipientFields(state: DeliverabilityAlertRecipientState) {
	return {
		userId: state.userId,
		status: state.status,
		attemptCount: state.attemptCount,
		attemptToken: state.attemptToken,
		attemptStartedAt: state.attemptStartedAt,
		nextAttemptAt: state.nextAttemptAt,
		sentAt: state.sentAt,
		unavailableReason: state.unavailableReason,
	};
}

async function loadRecipientDocs(
	ctx: MutationCtx,
	alertId: Id<'deliverabilityRegressionAlerts'>
): Promise<RecipientDoc[]> {
	const rows = await ctx.db
		.query('deliverabilityAlertRecipients')
		.withIndex('by_alert', (q) => q.eq('alertId', alertId))
		.take(DELIVERABILITY_ALERT_RECIPIENT_ROW_LIMIT + 1);
	return boundedDeliverabilityAlertRecipientRows(rows);
}

async function persistRecipientStates(
	ctx: MutationCtx,
	alert: Doc<'deliverabilityRegressionAlerts'>,
	entries: readonly RecipientEntry[]
): Promise<void> {
	for (const entry of entries) {
		if (entry.document) {
			await ctx.db.patch(entry.document._id, recipientFields(entry.state));
		} else {
			await ctx.db.insert('deliverabilityAlertRecipients', {
				organizationId: alert.organizationId,
				alertId: alert._id,
				...recipientFields(entry.state),
			});
		}
	}
}

async function reserveCurrentRecipientCapacity(
	ctx: MutationCtx,
	existing: readonly RecipientDoc[],
	currentRecipients: readonly DeliverabilityAlertAdminRecipient[]
): Promise<RecipientDoc[]> {
	const currentUserIds = new Set(currentRecipients.map((recipient) => recipient.userId));
	const existingUserIds = new Set(existing.map((recipient) => recipient.userId));
	const newCurrentCount = currentRecipients.filter(
		(recipient) => !existingUserIds.has(recipient.userId)
	).length;
	const overflow =
		existing.length + newCurrentCount - DELIVERABILITY_ALERT_RECIPIENT_COMPACTION_TARGET;
	if (overflow <= 0) return [...existing];

	const evictable = existing.filter(
		(recipient) =>
			!currentUserIds.has(recipient.userId) &&
			recipient.status !== 'sending' &&
			recipient.status !== 'sent' &&
			!(
				recipient.status === 'unavailable' &&
				recipient.unavailableReason === 'transport_outcome_unknown'
			)
	);
	const evictedIds = new Set(evictable.slice(0, overflow).map((recipient) => recipient._id));
	const retainedCount = existing.length - evictedIds.size;
	if (retainedCount + newCurrentCount > DELIVERABILITY_ALERT_RECIPIENT_ROW_LIMIT) {
		throw new Error(
			'Deliverability alert has too many protected recipient outcomes to add current admins'
		);
	}
	for (const recipientId of evictedIds) await ctx.db.delete(recipientId);
	return existing.filter((recipient) => !evictedIds.has(recipient._id));
}

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

function reconcileRecipientStates(
	existing: readonly RecipientEntry[],
	currentRecipients: readonly DeliverabilityAlertAdminRecipient[]
): RecipientEntry[] {
	const currentByUserId = new Map(
		currentRecipients.map((recipient) => [recipient.userId, recipient])
	);
	const knownUserIds = new Set(existing.map((entry) => entry.state.userId));
	const entries = existing.map((entry): RecipientEntry => {
		const state = entry.state;
		const current = currentByUserId.get(state.userId);
		if (state.status === 'sent') return entry;
		if (state.status === 'unavailable' && state.unavailableReason !== 'missing_email') {
			return entry;
		}
		if (state.status === 'sending') return entry;
		if (!current) {
			return {
				...entry,
				state: {
					...state,
					...cancelledDeliverabilityAlertRecipientPatch(),
				},
			};
		}
		if (!current.email) {
			return {
				...entry,
				state: {
					...state,
					status: 'unavailable',
					unavailableReason: 'missing_email',
					nextAttemptAt: undefined,
				},
			};
		}
		if (state.status === 'pending') return entry;
		return {
			...entry,
			state: {
				...state,
				status: 'pending',
				attemptToken: undefined,
				attemptStartedAt: undefined,
				nextAttemptAt: undefined,
				unavailableReason: undefined,
			},
		};
	});
	for (const recipient of currentByUserId.values()) {
		if (knownUserIds.has(recipient.userId)) continue;
		if (entries.length >= DELIVERABILITY_ALERT_RECIPIENT_ROW_LIMIT) {
			throw new Error('Deliverability alert could not represent every current admin');
		}
		entries.push({
			state: recipient.email
				? { userId: recipient.userId, status: 'pending', attemptCount: 0 }
				: {
						userId: recipient.userId,
						status: 'unavailable',
						attemptCount: 0,
						unavailableReason: 'missing_email',
					},
		});
	}
	return entries;
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
		const existing = await reserveCurrentRecipientCapacity(
			ctx,
			await loadRecipientDocs(ctx, alert._id),
			recipients
		);
		const entries = reconcileRecipientStates(
			existing.map((document) => ({
				document,
				state: toDeliverabilityAlertRecipientState(document),
			})),
			recipients
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
			...deliverabilityAlertNotificationPatch(states),
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
			state: deliverabilityAlertNotificationPatch(states).emailNotificationState,
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
		const docs = await loadRecipientDocs(ctx, alert._id);
		const entries = docs.map((document) => ({
			document,
			state: toDeliverabilityAlertRecipientState(document),
		}));
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
		const notificationPatch = deliverabilityAlertNotificationPatch(states);
		const state = notificationPatch.emailNotificationState;
		const earliestRetryAt = states.reduce<number | undefined>(
			(earliest, recipient) =>
				recipient.status === 'pending' && recipient.nextAttemptAt !== undefined
					? earliest === undefined
						? recipient.nextAttemptAt
						: Math.min(earliest, recipient.nextAttemptAt)
					: earliest,
			undefined
		);
		await persistRecipientStates(ctx, alert, entries);
		await ctx.db.patch(alert._id, notificationPatch);
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
		const docs = await loadRecipientDocs(ctx, alert._id);
		const entries = docs.map((document) => ({
			document,
			state: toDeliverabilityAlertRecipientState(document),
		}));
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
		await persistRecipientStates(ctx, alert, entries);
		const notificationPatch = deliverabilityAlertNotificationPatch(states);
		await ctx.db.patch(alert._id, notificationPatch);
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
		const docs = await loadRecipientDocs(ctx, alert._id);
		const entries = docs.map((document): RecipientEntry => {
			const state = toDeliverabilityAlertRecipientState(document);
			return {
				document,
				state:
					state.status === 'pending'
						? {
								...state,
								status: 'unavailable',
								nextAttemptAt: undefined,
								unavailableReason: 'recipient_directory_unavailable',
							}
						: state,
			};
		});
		const states = entries.map((entry) => entry.state);
		await persistRecipientStates(ctx, alert, entries);
		const notificationPatch = deliverabilityAlertNotificationPatch(states);
		await ctx.db.patch(alert._id, notificationPatch);
		return {
			state: notificationPatch.emailNotificationState,
			retryScheduled: false,
		};
	},
});
