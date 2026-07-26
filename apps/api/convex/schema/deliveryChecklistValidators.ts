import { v } from 'convex/values';
import {
	DELIVERABILITY_ALERT_RECIPIENT_STATUSES,
	DELIVERABILITY_ALERT_RECIPIENT_UNAVAILABLE_REASONS,
	DELIVERABILITY_CHECKLIST,
	type DeliverabilityCheckId,
} from '@owlat/shared';

const [firstDeliverabilityCheck, ...remainingDeliverabilityChecks] = DELIVERABILITY_CHECKLIST.map(
	(item) => item.id
) as [DeliverabilityCheckId, ...DeliverabilityCheckId[]];

export const deliverabilityCheckIdSchemaValidator = v.union(
	v.literal(firstDeliverabilityCheck),
	...remainingDeliverabilityChecks.map((item) => v.literal(item))
);

export const deliverabilityAlertRecipientStatusValidator = v.union(
	...DELIVERABILITY_ALERT_RECIPIENT_STATUSES.map((status) => v.literal(status))
);

export const deliverabilityAlertRecipientUnavailableReasonValidator = v.union(
	...DELIVERABILITY_ALERT_RECIPIENT_UNAVAILABLE_REASONS.map((reason) => v.literal(reason))
);
