/**
 * The outbound webhook event payloads of the public contract.
 *
 * A plain module with no imports, re-exported by `types.ts`: the JavaScript
 * SDK's declaration build inlines it into the published `.d.ts`.
 */

// ── Outbound webhook events (body: `{ event, timestamp, data }`, times ISO-8601) ──
export interface WebhookPayload<Event extends string, Data> {
	event: Event;
	timestamp: string;
	data: Data;
}
/** What both deliverability alert events say; see docs/webhook-payloads.md. */
export interface DeliverabilityAlertSubject {
	alertId: string;
	checkId: string;
	check: string;
	scope: 'deployment' | 'domain';
	domain: string | null;
}
/** `deliverability.alert_resolved`: the alert with this `alertId` closed. */
export interface DeliverabilityAlertResolvedData extends DeliverabilityAlertSubject {
	resolvedAt: string;
	/** `manual`: an admin resolved it; `automatic`: the check passed again or Owlat closed it. */
	resolution: 'manual' | 'automatic';
}
/** `deliverability.alert_raised`: a check that had passed regressed; `nextAction` is the fix the Deliverability Center shows for it. */
export interface DeliverabilityAlertRaisedData extends DeliverabilityAlertSubject {
	severity: string;
	message: string;
	nextAction: string;
	observedAt: string;
	/** The alert is about the server its own email leaves from; that email may not arrive. */
	emailMayNotArrive: boolean;
	/** Sent by "Send test alert"; no check regressed. */
	isTest: boolean;
}
export type DeliverabilityAlertRaisedWebhook = WebhookPayload<
	'deliverability.alert_raised',
	DeliverabilityAlertRaisedData
>;
export type DeliverabilityAlertResolvedWebhook = WebhookPayload<
	'deliverability.alert_resolved',
	DeliverabilityAlertResolvedData
>;
