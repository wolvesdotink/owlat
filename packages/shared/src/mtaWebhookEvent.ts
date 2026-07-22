/** Exhaustive runtime contract shared by the MTA durable outbox and Convex ingress. */

import { isDestinationProviderKey, type DestinationProviderKey } from './deliverabilityRouting';
import { isDeliveryDomain, type DeliveryDomain } from './routingDispatch';

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
	'dkim.rotated',
	'inbound.received',
	'routing.reentry',
	'inbound.mailbox.received',
] as const;

export type MtaWebhookEventType = (typeof MTA_WEBHOOK_EVENT_TYPES)[number];

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
	inboundPayload?: object;
	mailboxPayload?: object;
	routingReentryToken?: string;
	workAttemptId?: string;
	routingReentry?: object;
	routingReentryReason?:
		| 'routing_lease_stale'
		| 'circuit_breaker_changed'
		| 'warming_capacity_changed';
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
	  });

const EVENT_TYPES = new Set<string>(MTA_WEBHOOK_EVENT_TYPES);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CAMPAIGN_ID = /^[a-z0-9]{16,64}$/;
const EVENT_ID = /^[\x21-\x7e]{16,160}$/;

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
		!optionalBounded(value['message'], 512) ||
		!optionalBounded(value['errorCode'], 128) ||
		!optionalBounded(value['ip'], 64) ||
		!optionalBounded(value['domain'], 253) ||
		!optionalBounded(value['selector'], 128) ||
		!optionalBounded(value['dnsRecord'], 4096) ||
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
		!optionalRatio(value['userReportedSpamRatio'])
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
				bounded(value['message'], 512)
			);
		case 'campaign.complaint_rate':
			return (
				typeof value['eventId'] === 'string' &&
				EVENT_ID.test(value['eventId']) &&
				typeof value['campaignId'] === 'string' &&
				CAMPAIGN_ID.test(value['campaignId']) &&
				ratio(value['complaintRate']) &&
				bounded(value['message'], 512)
			);
		case 'ip.blocklisted':
			return (
				bounded(value['ip'], 64) &&
				bounded(value['message'], 512) &&
				(value['blocklists'] === undefined || boundedStrings(value['blocklists'], 100, 253))
			);
		case 'ip.delisted':
		case 'ip.warming_complete':
			return bounded(value['ip'], 64) && bounded(value['message'], 512);
		case 'all_ips_blocked':
			return bounded(value['message'], 512);
		case 'postmaster.authorize_domain':
			return bounded(value['domain'], 253);
		case 'postmaster.stats':
			return (
				bounded(value['domain'], 253) &&
				typeof value['date'] === 'string' &&
				DATE.test(value['date']) &&
				ratio(value['userReportedSpamRatio'])
			);
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

function boundedStrings(value: unknown, maximumItems: number, maximumLength: number): boolean {
	return (
		Array.isArray(value) &&
		value.length <= maximumItems &&
		value.every((item) => bounded(item, maximumLength))
	);
}
