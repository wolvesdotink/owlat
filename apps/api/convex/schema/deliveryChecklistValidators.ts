import { v } from 'convex/values';
import { literalUnion } from '../lib/convexValidators';
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

export const deliverabilityAlertRecipientStatusValidator = literalUnion(
	DELIVERABILITY_ALERT_RECIPIENT_STATUSES
);

export const deliverabilityAlertRecipientUnavailableReasonValidator = literalUnion(
	DELIVERABILITY_ALERT_RECIPIENT_UNAVAILABLE_REASONS
);
