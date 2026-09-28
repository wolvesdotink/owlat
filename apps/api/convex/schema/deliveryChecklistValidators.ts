import { literalUnion } from '../lib/literalUnion';
import {
	DELIVERABILITY_ALERT_RECIPIENT_STATUSES,
	DELIVERABILITY_ALERT_RECIPIENT_UNAVAILABLE_REASONS,
	DELIVERABILITY_CHECKLIST,
} from '@owlat/shared';

export const deliverabilityCheckIdSchemaValidator = literalUnion(
	DELIVERABILITY_CHECKLIST.map((item) => item.id)
);

export const deliverabilityAlertRecipientStatusValidator = literalUnion(
	DELIVERABILITY_ALERT_RECIPIENT_STATUSES
);

export const deliverabilityAlertRecipientUnavailableReasonValidator = literalUnion(
	DELIVERABILITY_ALERT_RECIPIENT_UNAVAILABLE_REASONS
);
