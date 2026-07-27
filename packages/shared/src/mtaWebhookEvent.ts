/** Exhaustive runtime contract shared by the MTA durable outbox and Convex ingress. */

import { isDestinationProviderKey, type DestinationProviderKey } from './deliverabilityRouting';
import { parseIpAddress } from './ipAddress';
import { isDeliveryDomain, type DeliveryDomain } from './routingDispatch';
import { isDeliverabilityProbeTokenFormat } from './deliverabilityProbeFormat';

export const MTA_WEBHOOK_EVENT_TYPES = [
	'sent',
	'bounced',
	'failed',
	'complained',
	'org.circuit_breaker',
	'campaign.complaint_rate',
	'ip.blocklisted',
	'ip.delisted',
	'ip.warming_complete',
	'all_ips_blocked',
	'postmaster.authorize_domain',
	'postmaster.stats',
	'postmaster.compliance',
	'dkim.rotated',
	'inbound.received',
	'routing.reentry',
	'inbound.mailbox.received',
	'ip.readiness_regressed',
	'deliverability.probe_observed',
] as const;

export type MtaWebhookEventType = (typeof MTA_WEBHOOK_EVENT_TYPES)[number];

// ─── Google Postmaster Tools contract ──────────────────────────────────────
// One definition of the shapes and of the sanitization bounds, imported by the
// MTA collector and by the Convex ingest. Each end still re-VALIDATES at its
// own trust boundary; what must never drift is the numbers it validates
// against — a collector that kept more checks than this guard accepts would
// have the whole event rejected and the day's verdict silently lost.

/** One Compliance Status check as Google reports it, normalized. */
export interface PostmasterComplianceCheck {
	name: string;
	state: 'passing' | 'failing' | 'unknown';
}

/** One delivery-error category's share of a domain's traffic for a day. */
export interface PostmasterDeliveryError {
	category: string;
	ratio: number;
}

/**
 * The only shape a Postmaster check name or delivery-error category may take.
 * Both are stored and rendered verbatim, so anything else is DROPPED rather
 * than escaped.
 */
export const POSTMASTER_TOKEN = /^[A-Z0-9_]{1,64}$/;
/** Upper bound on the Compliance Status checks carried for one domain/day. */
export const POSTMASTER_MAX_COMPLIANCE_CHECKS = 32;
/** Upper bound on the delivery-error categories carried for one domain/day. */
export const POSTMASTER_MAX_DELIVERY_ERROR_CATEGORIES = 24;

interface EventBase<K extends MtaWebhookEventType> {
	event: K;
	timestamp: number;
	eventId?: string;
	messageId?: string;
	recipient?: string;
	organizationId?: string;
	deliveryDomain?: DeliveryDomain;
	destinationProvider?: DestinationProviderKey;
	primarySendingDomain?: string;
	remoteMessageId?: string;
	severity?: 'info' | 'warning' | 'critical';
	message?: string;
	errorCode?: string;
	ip?: string;
	blocklists?: string[];
	bounceRate?: number;
	domain?: string;
	selector?: string;
	dnsRecord?: string;
	phase?: 'pending' | 'activated';
	campaignId?: string;
	complaintRate?: number;
	date?: string;
	userReportedSpamRatio?: number;
	spfSuccessRatio?: number;
	dkimSuccessRatio?: number;
	dmarcSuccessRatio?: number;
	deliveryErrorRatio?: number;
	deliveryErrors?: PostmasterDeliveryError[];
	checks?: PostmasterComplianceCheck[];
	inboundPayload?: object;
	mailboxPayload?: object;
	routingReentryToken?: string;
	workAttemptId?: string;
	routingReentry?: object;
	routingReentryReason?:
		| 'routing_lease_stale'
		| 'circuit_breaker_changed'
		| 'warming_capacity_changed';
	readinessCheck?: 'fcrdns' | 'spf';
	readinessReason?: string;
	eligibilityGeneration?: number;
	probeToken?: string;
	spfResult?: string;
	dkimResult?: string;
	dmarcResult?: string;
	tlsVersion?: string;
	ptr?: string;
}

export type SharedMtaWebhookEvent =
	| (EventBase<'sent'> & { messageId: string })
	| (EventBase<'bounced'> & {
			messageId?: string;
			recipient?: string;
			bounceType?: 'hard' | 'soft';
	  })
	| (EventBase<'failed'> & { messageId: string; message?: string; errorCode?: string })
	| (EventBase<'complained'> & { messageId?: string; recipient?: string; message?: string })
	| (EventBase<'org.circuit_breaker'> & {
			organizationId: string;
			bounceRate: number;
			message: string;
	  })
	| (EventBase<'campaign.complaint_rate'> & {
			eventId: string;
			campaignId: string;
			complaintRate: number;
			message: string;
	  })
	| (EventBase<'ip.blocklisted'> & { ip: string; message: string; blocklists?: string[] })
	| (EventBase<'ip.delisted'> & { ip: string; message: string })
	| (EventBase<'ip.warming_complete'> & { ip: string; message: string })
	| (EventBase<'all_ips_blocked'> & { message: string })
	| (EventBase<'postmaster.authorize_domain'> & { domain: string })
	| (EventBase<'postmaster.stats'> & {
			domain: string;
			date: string;
			userReportedSpamRatio: number;
			spfSuccessRatio?: number;
			dkimSuccessRatio?: number;
			dmarcSuccessRatio?: number;
			deliveryErrorRatio?: number;
			deliveryErrors?: PostmasterDeliveryError[];
	  })
	| (EventBase<'postmaster.compliance'> & {
			domain: string;
			date: string;
			checks: PostmasterComplianceCheck[];
	  })
	| (EventBase<'dkim.rotated'> & {
			domain: string;
			selector: string;
			dnsRecord: string;
			phase: 'pending' | 'activated';
	  })
	| (EventBase<'inbound.received'> & { organizationId: string; inboundPayload: object })
	| (EventBase<'routing.reentry'> & {
			messageId: string;
			routingReentryToken: string;
			workAttemptId: string;
			routingReentry: object;
			routingReentryReason:
				| 'routing_lease_stale'
				| 'circuit_breaker_changed'
				| 'warming_capacity_changed';
	  })
	| (EventBase<'inbound.mailbox.received'> & {
			organizationId: string;
			mailboxPayload: object;
	  })
	| (EventBase<'ip.readiness_regressed'> & {
			eventId: string;
			ip: string;
			readinessCheck: 'fcrdns' | 'spf';
			readinessReason: string;
			eligibilityGeneration: number;
			message: string;
	  })
	| (EventBase<'deliverability.probe_observed'> & {
			eventId: string;
			probeToken: string;
			spfResult: string;
			dkimResult: string;
			dmarcResult: string;
			ip: string;
			tlsVersion: string;
			ptr: string;
			selector?: string;
	  });

/**
 * The ingress bound on every human-readable `message` field. Convex rejects the
 * WHOLE event when it is exceeded, so producers that must not be dropped (the
 * DNSBL halt alert) build their message to fit against this exact number rather
 * than a duplicated literal.
 */
export const MTA_WEBHOOK_MESSAGE_MAX_LENGTH = 512;

const EVENT_TYPES = new Set<string>(MTA_WEBHOOK_EVENT_TYPES);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CAMPAIGN_ID = /^[a-z0-9]{16,64}$/;
const EVENT_ID = /^[\x21-\x7e]{16,160}$/;
const SPF_RESULTS = new Set([
	'pass',
	'fail',
	'softfail',
	'neutral',
	'none',
	'temperror',
	'permerror',
]);
const DKIM_RESULTS = new Set(['pass', 'fail', 'neutral', 'none', 'temperror', 'permerror']);
const DMARC_RESULTS = new Set(['pass', 'fail', 'none', 'temperror', 'permerror']);

export function isMtaWebhookEventType(value: unknown): value is MtaWebhookEventType {
	return typeof value === 'string' && EVENT_TYPES.has(value);
}

/** Validate the event-specific required fields plus every known optional field. */
export function isMtaWebhookEvent(value: unknown): value is SharedMtaWebhookEvent {
	if (!isRecord(value) || !isMtaWebhookEventType(value['event']) || !finite(value['timestamp'])) {
		return false;
	}
	if (!optionalBounded(value['eventId'], 160) || !optionalBounded(value['messageId'], 512)) {
		return false;
	}
	if (
		!optionalBounded(value['recipient'], 320) ||
		!optionalBounded(value['organizationId'], 128) ||
		!optionalBounded(value['message'], MTA_WEBHOOK_MESSAGE_MAX_LENGTH) ||
		!optionalBounded(value['errorCode'], 128) ||
		!optionalBounded(value['ip'], 64) ||
		!optionalBounded(value['domain'], 253) ||
		!optionalBounded(value['selector'], 128) ||
		!optionalBounded(value['dnsRecord'], 4096) ||
		!optionalBounded(value['probeToken'], 128) ||
		!optionalBounded(value['spfResult'], 32) ||
		!optionalBounded(value['dkimResult'], 32) ||
		!optionalBounded(value['dmarcResult'], 32) ||
		!optionalBounded(value['tlsVersion'], 64) ||
		!optionalBounded(value['ptr'], 512) ||
		!optionalBounded(value['primarySendingDomain'], 253) ||
		!optionalBounded(value['remoteMessageId'], 512) ||
		(value['deliveryDomain'] !== undefined && !isDeliveryDomain(value['deliveryDomain'])) ||
		(value['destinationProvider'] !== undefined &&
			!isDestinationProviderKey(value['destinationProvider'])) ||
		(value['severity'] !== undefined &&
			value['severity'] !== 'info' &&
			value['severity'] !== 'warning' &&
			value['severity'] !== 'critical') ||
		(value['blocklists'] !== undefined && !boundedStrings(value['blocklists'], 100, 253)) ||
		!optionalRatio(value['bounceRate']) ||
		!optionalRatio(value['complaintRate']) ||
		!optionalRatio(value['userReportedSpamRatio']) ||
		!optionalRatio(value['spfSuccessRatio']) ||
		!optionalRatio(value['dkimSuccessRatio']) ||
		!optionalRatio(value['dmarcSuccessRatio']) ||
		!optionalRatio(value['deliveryErrorRatio']) ||
		(value['deliveryErrors'] !== undefined && !isDeliveryErrorBreakdown(value['deliveryErrors'])) ||
		(value['checks'] !== undefined && !isComplianceChecks(value['checks']))
	) {
		return false;
	}

	switch (value['event']) {
		case 'sent':
		case 'failed':
			return bounded(value['messageId'], 512);
		case 'bounced':
			return (
				(bounded(value['messageId'], 512) || bounded(value['recipient'], 320)) &&
				(value['bounceType'] === undefined ||
					value['bounceType'] === 'hard' ||
					value['bounceType'] === 'soft')
			);
		case 'complained':
			return bounded(value['messageId'], 512) || bounded(value['recipient'], 320);
		case 'org.circuit_breaker':
			return (
				bounded(value['organizationId'], 128) &&
				ratio(value['bounceRate']) &&
				bounded(value['message'], MTA_WEBHOOK_MESSAGE_MAX_LENGTH)
			);
		case 'campaign.complaint_rate':
			return (
				typeof value['eventId'] === 'string' &&
				EVENT_ID.test(value['eventId']) &&
				typeof value['campaignId'] === 'string' &&
				CAMPAIGN_ID.test(value['campaignId']) &&
				ratio(value['complaintRate']) &&
				bounded(value['message'], MTA_WEBHOOK_MESSAGE_MAX_LENGTH)
			);
		case 'ip.blocklisted':
			return (
				bounded(value['ip'], 64) &&
				bounded(value['message'], MTA_WEBHOOK_MESSAGE_MAX_LENGTH) &&
				(value['blocklists'] === undefined || boundedStrings(value['blocklists'], 100, 253))
			);
		case 'ip.delisted':
		case 'ip.warming_complete':
			return bounded(value['ip'], 64) && bounded(value['message'], MTA_WEBHOOK_MESSAGE_MAX_LENGTH);
		case 'all_ips_blocked':
			return bounded(value['message'], MTA_WEBHOOK_MESSAGE_MAX_LENGTH);
		case 'postmaster.authorize_domain':
			return bounded(value['domain'], 253);
		case 'postmaster.stats':
			return (
				bounded(value['domain'], 253) &&
				typeof value['date'] === 'string' &&
				DATE.test(value['date']) &&
				ratio(value['userReportedSpamRatio'])
			);
		case 'postmaster.compliance': {
			// Shape and bounds are already enforced above for every kind; a
			// verdict with nothing in it is what this one kind additionally rejects.
			const checks = value['checks'];
			return (
				bounded(value['domain'], 253) &&
				typeof value['date'] === 'string' &&
				DATE.test(value['date']) &&
				Array.isArray(checks) &&
				checks.length > 0
			);
		}
		case 'dkim.rotated':
			return (
				bounded(value['domain'], 253) &&
				bounded(value['selector'], 128) &&
				bounded(value['dnsRecord'], 4096) &&
				(value['phase'] === 'pending' || value['phase'] === 'activated')
			);
		case 'inbound.received':
			return bounded(value['organizationId'], 128) && isRecord(value['inboundPayload']);
		case 'routing.reentry':
			return (
				bounded(value['messageId'], 512) &&
				bounded(value['routingReentryToken'], 4096) &&
				bounded(value['workAttemptId'], 512) &&
				isRecord(value['routingReentry']) &&
				(value['routingReentryReason'] === 'routing_lease_stale' ||
					value['routingReentryReason'] === 'circuit_breaker_changed' ||
					value['routingReentryReason'] === 'warming_capacity_changed')
			);
		case 'inbound.mailbox.received':
			return bounded(value['organizationId'], 128) && isRecord(value['mailboxPayload']);
		case 'ip.readiness_regressed': {
			const parsedIp = typeof value['ip'] === 'string' ? parseIpAddress(value['ip']) : null;
			const check = value['readinessCheck'];
			const reason = value['readinessReason'];
			const confirmedReason =
				(check === 'fcrdns' &&
					(reason === 'no-ptr' ||
						reason === 'ptr-not-fqdn' ||
						reason === 'forward-mismatch' ||
						reason === 'ehlo-mismatch')) ||
				(check === 'spf' &&
					(reason === 'no-spf-record' ||
						reason === 'multiple-spf-records' ||
						reason === 'missing-ip6-mechanism'));
			return (
				typeof value['eventId'] === 'string' &&
				EVENT_ID.test(value['eventId']) &&
				parsedIp?.family === 'ipv6' &&
				parsedIp.address === value['ip'] &&
				confirmedReason &&
				typeof value['eligibilityGeneration'] === 'number' &&
				Number.isSafeInteger(value['eligibilityGeneration']) &&
				value['eligibilityGeneration'] >= 1 &&
				bounded(value['message'], MTA_WEBHOOK_MESSAGE_MAX_LENGTH)
			);
		}
		case 'deliverability.probe_observed':
			return (
				typeof value['eventId'] === 'string' &&
				EVENT_ID.test(value['eventId']) &&
				typeof value['probeToken'] === 'string' &&
				isDeliverabilityProbeTokenFormat(value['probeToken']) &&
				typeof value['spfResult'] === 'string' &&
				SPF_RESULTS.has(value['spfResult']) &&
				typeof value['dkimResult'] === 'string' &&
				DKIM_RESULTS.has(value['dkimResult']) &&
				typeof value['dmarcResult'] === 'string' &&
				DMARC_RESULTS.has(value['dmarcResult']) &&
				typeof value['ip'] === 'string' &&
				parseIpAddress(value['ip']) !== null &&
				bounded(value['tlsVersion'], 64) &&
				bounded(value['ptr'], 512)
			);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function ratio(value: unknown): value is number {
	return finite(value) && value >= 0 && value <= 1;
}

function optionalRatio(value: unknown): boolean {
	return value === undefined || ratio(value);
}

function bounded(value: unknown, maximum: number): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

function optionalBounded(value: unknown, maximum: number): boolean {
	return value === undefined || bounded(value, maximum);
}

/** Bounded `{ category, ratio }` list — the Postmaster delivery-error breakdown. */
function isDeliveryErrorBreakdown(value: unknown): boolean {
	return (
		Array.isArray(value) &&
		value.length <= POSTMASTER_MAX_DELIVERY_ERROR_CATEGORIES &&
		value.every(
			(item) =>
				isRecord(item) &&
				typeof item['category'] === 'string' &&
				POSTMASTER_TOKEN.test(item['category']) &&
				ratio(item['ratio'])
		)
	);
}

/**
 * Bounded Compliance Status checks with enum-shaped names. An EMPTY list is
 * well-formed here: `checks` rides on {@link EventBase} for every event kind,
 * so it is bounded at the top level for all of them and only the
 * `postmaster.compliance` case additionally requires a non-empty verdict.
 */
function isComplianceChecks(value: unknown): boolean {
	return (
		Array.isArray(value) &&
		value.length <= POSTMASTER_MAX_COMPLIANCE_CHECKS &&
		value.every(
			(item) =>
				isRecord(item) &&
				typeof item['name'] === 'string' &&
				POSTMASTER_TOKEN.test(item['name']) &&
				(item['state'] === 'passing' || item['state'] === 'failing' || item['state'] === 'unknown')
		)
	);
}

function boundedStrings(value: unknown, maximumItems: number, maximumLength: number): boolean {
	return (
		Array.isArray(value) &&
		value.length <= maximumItems &&
		value.every((item) => bounded(item, maximumLength))
	);
}
