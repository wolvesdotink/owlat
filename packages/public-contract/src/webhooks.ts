/**
 * Outbound webhook payloads: what Owlat POSTs to a subscribed endpoint.
 *
 * The API server builds these bodies from its webhook event modules and
 * checks them against these schemas in its tests; a receiver can decode with
 * them. Event data holds flat JSON primitives only.
 */

import { z } from 'zod';

const isoTime = z.iso.datetime();
const scope = z.enum(['deployment', 'domain']);

export const deliverabilityAlertRaisedDataSchema = z.strictObject({
	alertId: z.string(),
	checkId: z.string(),
	check: z.string(),
	severity: z.string(),
	scope,
	domain: z.string().nullable(),
	message: z.string(),
	observedAt: isoTime,
	emailMayNotArrive: z.boolean(),
	isTest: z.boolean(),
});

export const deliverabilityAlertResolvedDataSchema = z.strictObject({
	alertId: z.string(),
	checkId: z.string(),
	check: z.string(),
	scope,
	domain: z.string().nullable(),
	resolvedAt: isoTime,
	resolution: z.enum(['manual', 'automatic']),
});

export const deliverabilityAlertRaisedWebhookSchema = z.strictObject({
	event: z.literal('deliverability.alert_raised'),
	timestamp: isoTime,
	data: deliverabilityAlertRaisedDataSchema,
});

export const deliverabilityAlertResolvedWebhookSchema = z.strictObject({
	event: z.literal('deliverability.alert_resolved'),
	timestamp: isoTime,
	data: deliverabilityAlertResolvedDataSchema,
});
