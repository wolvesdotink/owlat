import {
	DELIVERABILITY_ALERT_RECIPIENT_LIMIT,
	type DeliverabilityAlertRecipientState,
} from '@owlat/shared';

export const DELIVERABILITY_ALERT_RECIPIENT_COMPACTION_TARGET = 120;
export const DELIVERABILITY_ALERT_RECIPIENT_ROW_LIMIT =
	DELIVERABILITY_ALERT_RECIPIENT_COMPACTION_TARGET + DELIVERABILITY_ALERT_RECIPIENT_LIMIT;

type AlertNotificationState = 'pending' | 'sent' | 'unavailable';

export function boundedDeliverabilityAlertRecipientRows<T>(rows: readonly T[]): T[] {
	if (rows.length > DELIVERABILITY_ALERT_RECIPIENT_ROW_LIMIT) {
		throw new Error('Deliverability alert recipient ledger exceeds its bounded limit');
	}
	return [...rows];
}

export function toDeliverabilityAlertRecipientState(
	recipient: DeliverabilityAlertRecipientState
): DeliverabilityAlertRecipientState {
	return {
		userId: recipient.userId,
		status: recipient.status,
		attemptCount: recipient.attemptCount,
		...(recipient.attemptToken ? { attemptToken: recipient.attemptToken } : {}),
		...(recipient.attemptStartedAt !== undefined
			? { attemptStartedAt: recipient.attemptStartedAt }
			: {}),
		...(recipient.nextAttemptAt !== undefined ? { nextAttemptAt: recipient.nextAttemptAt } : {}),
		...(recipient.sentAt !== undefined ? { sentAt: recipient.sentAt } : {}),
		...(recipient.unavailableReason ? { unavailableReason: recipient.unavailableReason } : {}),
	};
}

export function cancelledDeliverabilityAlertRecipientPatch(): {
	status: 'cancelled';
	attemptToken: undefined;
	attemptStartedAt: undefined;
	nextAttemptAt: undefined;
	unavailableReason: undefined;
} {
	return {
		status: 'cancelled',
		attemptToken: undefined,
		attemptStartedAt: undefined,
		nextAttemptAt: undefined,
		unavailableReason: undefined,
	};
}

export function deliverabilityAlertNotificationPatch(
	states: readonly DeliverabilityAlertRecipientState[]
): {
	emailNotificationState: AlertNotificationState;
	emailNotifiedAt: number | undefined;
} {
	const hasInFlightRecipient = states.some(
		(state) => state.status === 'pending' || state.status === 'sending'
	);
	const earliestSentAt = states.reduce<number | undefined>(
		(earliest, recipient) =>
			recipient.status === 'sent' && recipient.sentAt !== undefined
				? earliest === undefined
					? recipient.sentAt
					: Math.min(earliest, recipient.sentAt)
				: earliest,
		undefined
	);
	return {
		emailNotificationState: hasInFlightRecipient
			? 'pending'
			: earliestSentAt !== undefined
				? 'sent'
				: 'unavailable',
		emailNotifiedAt: earliestSentAt,
	};
}
