/**
 * deliverability.alert_resolved — an alert announced by
 * `deliverability.alert_raised` is closed: its check passed again, an admin
 * resolved it, or Owlat closed it (IPv6 turned off, retention). Sent once per
 * alert, so a receiver can close the incident it opened for `alertId`.
 *
 * Customer-facing contract: see docs/webhook-payloads.md.
 */

import { v, type Infer } from 'convex/values';
import type { WebhookEventModule } from '../../types';

const schema = v.object({
	alertId: v.string(),
	checkId: v.string(),
	check: v.string(),
	scope: v.union(v.literal('deployment'), v.literal('domain')),
	domain: v.union(v.string(), v.null()),
	resolvedAt: v.string(),
	resolution: v.union(v.literal('manual'), v.literal('automatic')),
});

type Data = Infer<typeof schema>;

export interface DeliverabilityAlertResolvedInput {
	alertId: string;
	checkId: string;
	check: string;
	domain: string | null;
	resolvedAt: number;
	/** `manual`: an admin resolved it; `automatic`: Owlat closed it. */
	resolution: 'manual' | 'automatic';
}

export const deliverabilityAlertResolved: WebhookEventModule<
	'deliverability.alert_resolved',
	DeliverabilityAlertResolvedInput,
	Data
> = {
	literal: 'deliverability.alert_resolved',
	description: 'A deliverability alert was resolved',
	isSubscribable: true,
	schema,
	build(input) {
		return {
			alertId: input.alertId,
			checkId: input.checkId,
			check: input.check,
			scope: input.domain === null ? 'deployment' : 'domain',
			domain: input.domain,
			resolvedAt: new Date(input.resolvedAt).toISOString(),
			resolution: input.resolution,
		};
	},
};
