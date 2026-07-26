import {
	type DeliverabilityAlertAdminRecipient,
	type DeliverabilityAlertRecipientState,
} from '@owlat/shared';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import {
	DELIVERABILITY_ALERT_RECIPIENT_COMPACTION_TARGET,
	DELIVERABILITY_ALERT_RECIPIENT_ROW_LIMIT,
	boundedDeliverabilityAlertRecipientRows,
	cancelledDeliverabilityAlertRecipientPatch,
	type CompactedDeliverabilityAlertOutcomes,
} from './checklistAlertRecipients';

type RecipientDoc = Doc<'deliverabilityAlertRecipients'>;

export type RecipientEntry = {
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

export async function loadRecipientDocs(
	ctx: MutationCtx,
	alertId: Id<'deliverabilityRegressionAlerts'>
): Promise<RecipientDoc[]> {
	const rows = await ctx.db
		.query('deliverabilityAlertRecipients')
		.withIndex('by_alert', (q) => q.eq('alertId', alertId))
		.take(DELIVERABILITY_ALERT_RECIPIENT_ROW_LIMIT + 1);
	return boundedDeliverabilityAlertRecipientRows(rows);
}

export async function persistRecipientStates(
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

async function persistProtectedRecipientReceipt(
	ctx: MutationCtx,
	alert: Doc<'deliverabilityRegressionAlerts'>,
	recipient: RecipientDoc,
	outcome: 'sent' | 'transport_outcome_unknown'
): Promise<boolean> {
	if (recipient.userId === '[deleted account]') return true;
	const existing = await ctx.db
		.query('deliverabilityAlertRecipientReceipts')
		.withIndex('by_alert_and_user', (q) =>
			q.eq('alertId', alert._id).eq('userId', recipient.userId)
		)
		.unique();
	if (existing) return false;
	await ctx.db.insert('deliverabilityAlertRecipientReceipts', {
		organizationId: alert.organizationId,
		alertId: alert._id,
		userId: recipient.userId,
		outcome,
		sentAt: outcome === 'sent' ? recipient.sentAt : undefined,
		createdAt: Date.now(),
	});
	return true;
}

export async function reserveCurrentRecipientCapacity(
	ctx: MutationCtx,
	alert: Doc<'deliverabilityRegressionAlerts'>,
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

	const evictable = existing
		.filter((recipient) => !currentUserIds.has(recipient.userId) && recipient.status !== 'sending')
		.sort((left, right) => {
			const isProtected = (recipient: RecipientDoc) =>
				recipient.status === 'sent' ||
				(recipient.status === 'unavailable' &&
					recipient.unavailableReason === 'transport_outcome_unknown');
			return Number(isProtected(left)) - Number(isProtected(right));
		});
	const evicted = evictable.slice(0, overflow);
	const evictedIds = new Set(evicted.map((recipient) => recipient._id));
	const retainedCount = existing.length - evictedIds.size;
	if (retainedCount + newCurrentCount > DELIVERABILITY_ALERT_RECIPIENT_ROW_LIMIT) {
		throw new Error(
			'Deliverability alert has too many protected recipient outcomes to add current admins'
		);
	}
	for (const recipientId of evictedIds) await ctx.db.delete(recipientId);
	if (evicted.length > 0) {
		const compactedOutcomes: CompactedDeliverabilityAlertOutcomes = {
			sent: alert.compactedRecipientOutcomes?.sent ?? 0,
			transportOutcomeUnknown: alert.compactedRecipientOutcomes?.transportOutcomeUnknown ?? 0,
			deliveryFailed: alert.compactedRecipientOutcomes?.deliveryFailed ?? 0,
			unavailable: alert.compactedRecipientOutcomes?.unavailable ?? 0,
			cancelled: alert.compactedRecipientOutcomes?.cancelled ?? 0,
			earliestSentAt: alert.compactedRecipientOutcomes?.earliestSentAt,
		};
		for (const recipient of evicted) {
			if (recipient.status === 'sent') {
				const created = await persistProtectedRecipientReceipt(ctx, alert, recipient, 'sent');
				if (!created) continue;
				compactedOutcomes.sent += 1;
				if (recipient.sentAt !== undefined) {
					compactedOutcomes.earliestSentAt =
						compactedOutcomes.earliestSentAt === undefined
							? recipient.sentAt
							: Math.min(compactedOutcomes.earliestSentAt, recipient.sentAt);
				}
			} else if (
				recipient.status === 'unavailable' &&
				recipient.unavailableReason === 'transport_outcome_unknown'
			) {
				const created = await persistProtectedRecipientReceipt(
					ctx,
					alert,
					recipient,
					'transport_outcome_unknown'
				);
				if (created) compactedOutcomes.transportOutcomeUnknown += 1;
			} else if (
				recipient.status === 'unavailable' &&
				recipient.unavailableReason === 'delivery_failed'
			) {
				compactedOutcomes.deliveryFailed += 1;
			} else if (recipient.status === 'unavailable') {
				compactedOutcomes.unavailable += 1;
			} else {
				// A departed pending row becomes historical cancellation rather
				// than pretending a delivery outcome occurred.
				compactedOutcomes.cancelled += 1;
			}
		}
		await ctx.db.patch(alert._id, { compactedRecipientOutcomes: compactedOutcomes });
		alert.compactedRecipientOutcomes = compactedOutcomes;
	}
	return existing.filter((recipient) => !evictedIds.has(recipient._id));
}

export function reconcileRecipientStates(
	existing: readonly RecipientEntry[],
	currentRecipients: readonly DeliverabilityAlertAdminRecipient[],
	protectedReceipts: ReadonlyMap<
		string,
		{ outcome: 'sent' | 'transport_outcome_unknown'; sentAt?: number }
	>
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
		const protectedReceipt = protectedReceipts.get(recipient.userId);
		entries.push({
			state:
				protectedReceipt?.outcome === 'sent'
					? {
							userId: recipient.userId,
							status: 'sent',
							attemptCount: 0,
							sentAt: protectedReceipt.sentAt,
						}
					: protectedReceipt?.outcome === 'transport_outcome_unknown'
						? {
								userId: recipient.userId,
								status: 'unavailable',
								attemptCount: 0,
								unavailableReason: 'transport_outcome_unknown',
							}
						: recipient.email
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
