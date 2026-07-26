export const DELIVERABILITY_ALERT_RECIPIENT_LIMIT = 50;

export const DELIVERABILITY_ALERT_RECIPIENT_STATUSES = [
	'pending',
	'sending',
	'sent',
	'unavailable',
	'cancelled',
] as const;

export type DeliverabilityAlertRecipientStatus =
	(typeof DELIVERABILITY_ALERT_RECIPIENT_STATUSES)[number];

export const DELIVERABILITY_ALERT_RECIPIENT_UNAVAILABLE_REASONS = [
	'missing_email',
	'recipient_directory_unavailable',
	'delivery_failed',
	'transport_outcome_unknown',
] as const;

export type DeliverabilityAlertRecipientUnavailableReason =
	(typeof DELIVERABILITY_ALERT_RECIPIENT_UNAVAILABLE_REASONS)[number];

export type DeliverabilityAlertRecipientState = {
	userId: string;
	status: DeliverabilityAlertRecipientStatus;
	attemptCount: number;
	attemptToken?: string;
	attemptStartedAt?: number;
	nextAttemptAt?: number;
	sentAt?: number;
	unavailableReason?: DeliverabilityAlertRecipientUnavailableReason;
};

export type DeliverabilityAlertAdminRecipient = {
	userId: string;
	email?: string;
};
