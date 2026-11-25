/**
 * deliverability.alert_raised — a deliverability check that had passed
 * regressed and Owlat raised an alert (a sending IP on a blocklist, port 25
 * blocked, a DKIM record gone). Sent at the same moment as the alert email,
 * so an operator's on-call tool hears about it even when the mail server the
 * alert is about cannot deliver that email. `emailMayNotArrive` says so.
 *
 * Also sent when sending on the instance stops (`checkId`
 * `deployment.sending_hold`, `delivery/sendingHoldAlerts.ts`), with the hold's
 * status and how it lifts (raised again, with `previousHoldStatus`, when the
 * status changes while sending stays stopped), and with `isTest: true` by the Deliverability
 * Center's "Send test alert", so a receiver can tell a drill from an incident.
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
	nextAction: v.string(),
	observedAt: v.string(),
	emailMayNotArrive: v.boolean(),
	isTest: v.boolean(),
	holdStatus: v.optional(v.union(v.literal('suspended'), v.literal('banned'))),
	previousHoldStatus: v.optional(v.union(v.literal('suspended'), v.literal('banned'))),
	lift: v.optional(v.string()),
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
	/** The fix the Deliverability Center shows for this check. */
	nextAction: string;
	observedAt: number;
	emailMayNotArrive: boolean;
	isTest: boolean;
	/** A sending hold only: the status that stopped sending. */
	holdStatus?: 'suspended' | 'banned';
	/** A sending hold only: set when this raise changed the status of a hold that already stood. */
	previousHoldStatus?: 'suspended' | 'banned';
	/** A sending hold only: the `SendingHoldLift` as JSON text (event data is flat). */
	lift?: string;
}

export const deliverabilityAlertRaised: WebhookEventModule<
	'deliverability.alert_raised',
	DeliverabilityAlertRaisedInput,
	Data
> = {
	literal: 'deliverability.alert_raised',
	description: 'A deliverability check regressed or sending stopped, and Owlat raised an alert',
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
			nextAction: input.nextAction,
			observedAt: new Date(input.observedAt).toISOString(),
			emailMayNotArrive: input.emailMayNotArrive,
			isTest: input.isTest,
			...(input.holdStatus ? { holdStatus: input.holdStatus } : {}),
			...(input.previousHoldStatus ? { previousHoldStatus: input.previousHoldStatus } : {}),
			...(input.lift !== undefined ? { lift: input.lift } : {}),
		};
	},
};
