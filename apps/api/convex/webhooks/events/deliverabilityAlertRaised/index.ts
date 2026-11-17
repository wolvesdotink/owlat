/**
 * deliverability.alert_raised — a deliverability check that had passed
 * regressed and Owlat raised an alert (a sending IP on a blocklist, port 25
 * blocked, a DKIM record gone). Sent at the same moment as the alert email,
 * so an operator's on-call tool hears about it even when the mail server the
 * alert is about cannot deliver that email. `emailMayNotArrive` says so.
 *
 * Also sent with `isTest: true` by the Deliverability Center's "Send test
 * alert", so a receiver can tell a drill from an incident.
 *
 * Customer-facing contract: see docs/webhook-payloads.md.
 */

import { v, type Infer } from 'convex/values';
import type { WebhookEventModule } from '../../types';

const schema = v.object({
	alertId: v.string(),
	checkId: v.string(),
	check: v.string(),
	severity: v.string(),
	scope: v.union(v.literal('deployment'), v.literal('domain')),
	domain: v.union(v.string(), v.null()),
	message: v.string(),
	observedAt: v.string(),
	emailMayNotArrive: v.boolean(),
	isTest: v.boolean(),
});

type Data = Infer<typeof schema>;

export interface DeliverabilityAlertRaisedInput {
	alertId: string;
	checkId: string;
	/** The check's protocol name ("Outbound SMTP port 25"). */
	check: string;
	severity: string;
	domain: string | null;
	message: string;
	observedAt: number;
	emailMayNotArrive: boolean;
	isTest: boolean;
}

export const deliverabilityAlertRaised: WebhookEventModule<
	'deliverability.alert_raised',
	DeliverabilityAlertRaisedInput,
	Data
> = {
	literal: 'deliverability.alert_raised',
	description: 'A deliverability check regressed and Owlat raised an alert',
	isSubscribable: true,
	schema,
	build(input) {
		return {
			alertId: input.alertId,
			checkId: input.checkId,
			check: input.check,
			severity: input.severity,
			scope: input.domain === null ? 'deployment' : 'domain',
			domain: input.domain,
			message: input.message,
			observedAt: new Date(input.observedAt).toISOString(),
			emailMayNotArrive: input.emailMayNotArrive,
			isTest: input.isTest,
		};
	},
};
