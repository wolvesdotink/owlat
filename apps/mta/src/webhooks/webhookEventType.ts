import type { MtaWebhookEventType } from '../types.js';

const WEBHOOK_EVENT_TYPES = {
	sent: true,
	bounced: true,
	failed: true,
	complained: true,
	'org.circuit_breaker': true,
	'campaign.complaint_rate': true,
	'ip.blocklisted': true,
	'ip.delisted': true,
	'ip.warming_complete': true,
	all_ips_blocked: true,
	'postmaster.authorize_domain': true,
	'postmaster.stats': true,
	'dkim.rotated': true,
	'inbound.received': true,
	'routing.reentry': true,
	'inbound.mailbox.received': true,
} satisfies Record<MtaWebhookEventType, true>;

/** Runtime counterpart to the exhaustive MtaWebhookEventType union. */
export function isMtaWebhookEventType(value: unknown): value is MtaWebhookEventType {
	return typeof value === 'string' && Object.hasOwn(WEBHOOK_EVENT_TYPES, value);
}
