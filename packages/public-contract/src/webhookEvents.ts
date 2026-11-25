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
	/** `manual`: an admin resolved it (a platform admin lifted a sending hold); `automatic`: the check passed again, the reputation check lifted the hold, or Owlat closed it. */
	resolution: 'manual' | 'automatic';
}
/** `deliverability.alert_raised`: a check that had passed regressed, or sending on the instance stopped (`checkId` `deployment.sending_hold`); `nextAction` says what to do. */
export interface DeliverabilityAlertRaisedData extends DeliverabilityAlertSubject {
	severity: string;
	message: string;
	nextAction: string;
	observedAt: string;
	/** The alert is about the server its own email leaves from; that email may not arrive. */
	emailMayNotArrive: boolean;
	/** Sent by "Send test alert"; no check regressed. */
	isTest: boolean;
	/** Set only on a `deployment.sending_hold` alert: sending on the instance stopped. */
	holdStatus?: 'suspended' | 'banned';
	/**
	 * Set only on a `deployment.sending_hold` alert raised again because the
	 * hold's status changed while sending stayed stopped (suspended to banned,
	 * or back): the status it had. The `alertId` is the first raise's.
	 */
	previousHoldStatus?: 'suspended' | 'banned';
	/**
	 * Set only on a `deployment.sending_hold` alert: how sending comes back, as
	 * the JSON text of a `SendingHoldLift` (the `sendingHold.lift` of
	 * `GET /api/v1/status`), because event data holds flat values only.
	 */
	lift?: string;
}
export type DeliverabilityAlertRaisedWebhook = WebhookPayload<
	'deliverability.alert_raised',
	DeliverabilityAlertRaisedData
>;
export type DeliverabilityAlertResolvedWebhook = WebhookPayload<
	'deliverability.alert_resolved',
	DeliverabilityAlertResolvedData
>;
