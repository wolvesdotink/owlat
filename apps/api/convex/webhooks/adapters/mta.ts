/**
 * MTA webhook adapter — verifies HMAC-SHA256 over `${timestamp}.${body}` and
 * parses owlat-mta service events into InboundEvent. See CONTEXT.md
 * "Inbound adapter".
 *
 * MTA pre-classifies bounces on the sending side (DSN status codes → hard/
 * soft) so the adapter trusts `payload.bounceType` and does no further
 * classification. Postbox routing (`pb-` prefix on messageId) lives in the
 * dispatcher, not here.
 *
 * Inbound mail (`inbound.received`) delegates parsing to the existing
 * `@owlat/channels` inbound adapter so the MTA SMTP server and the
 * webhook share the same envelope-to-NormalizedInboundMail translation.
 */

import { getInboundChannelAdapter } from '@owlat/channels';
import { getOptional } from '../../lib/env';
import { constantTimeEqual, hmacSha256Hex, missingSecretResult } from '../security';
import type { InboundAdapter } from '../pipeline';
import type { InboundEvent } from '../types';

interface MtaWebhookPayload {
	event: string;
	messageId?: string;
	/** Complained recipient address (RFC 5965 §3.2) when no Message-ID. */
	recipient?: string;
	bounceType?: 'hard' | 'soft';
	message?: string;
	ip?: string;
	blocklists?: string[];
	severity?: 'info' | 'warning' | 'critical';
	bounceRate?: number;
	/** DKIM rotation callback fields (event `dkim.rotated`). */
	domain?: string;
	selector?: string;
	dnsRecord?: string;
	phase?: 'pending' | 'activated';
	campaignId?: string;
	complaintRate?: number;
	inboundPayload?: {
		from: string;
		to: string;
		subject: string;
		textBody?: string;
		htmlBody?: string;
		headers: Record<string, string>;
		date?: string;
		messageId?: string;
		inReplyTo?: string;
		references?: string;
		attachments: Array<{
			filename?: string;
			contentType: string;
			size: number;
			redisKey?: string;
		}>;
	};
	timestamp: number;
}

const MTA_TIMESTAMP_TOLERANCE_SECONDS = 300; // 5 minutes

const IP_EVENT_SUBKIND: Record<
	string,
	'blocklisted' | 'delisted' | 'warming_complete' | 'all_blocked'
> = {
	'ip.blocklisted': 'blocklisted',
	'ip.delisted': 'delisted',
	'ip.warming_complete': 'warming_complete',
	all_ips_blocked: 'all_blocked',
};

export async function verifyMtaHeaders(
	body: string,
	signature: string,
	timestamp: string,
	secret: string,
	nowSeconds: number = Math.floor(Date.now() / 1000)
): Promise<boolean> {
	const timestampSeconds = parseInt(timestamp, 10);
	if (isNaN(timestampSeconds)) return false;
	if (Math.abs(nowSeconds - timestampSeconds) > MTA_TIMESTAMP_TOLERANCE_SECONDS) {
		return false;
	}

	const expected = await hmacSha256Hex(secret, `${timestamp}.${body}`);
	return constantTimeEqual(signature, expected);
}

export const mtaAdapter: InboundAdapter = {
	source: 'mta',

	async verifySignature(request, rawBody) {
		const secret = getOptional('MTA_WEBHOOK_SECRET');
		if (!secret) {
			return missingSecretResult('MTA_WEBHOOK_SECRET');
		}

		const signature = request.headers.get('x-mta-signature');
		const timestamp = request.headers.get('x-mta-timestamp');

		if (!signature || !timestamp) {
			return {
				ok: false,
				status: 401,
				reason: 'Missing X-MTA-Signature or X-MTA-Timestamp header',
			};
		}

		const isValid = await verifyMtaHeaders(rawBody, signature, timestamp, secret);
		if (!isValid) {
			return {
				ok: false,
				status: 401,
				reason: 'Invalid MTA signature or stale timestamp',
			};
		}

		return { ok: true };
	},

	parseEvent(rawBody): InboundEvent | null {
		const payload = JSON.parse(rawBody) as MtaWebhookPayload;

		switch (payload.event) {
			case 'bounced': {
				if (!payload.messageId) return null;
				return {
					kind: 'email.bounced',
					providerMessageId: payload.messageId,
					at: payload.timestamp,
					bounceType: payload.bounceType === 'hard' ? 'hard' : 'soft',
					...(payload.message ? { bounceMessage: payload.message } : {}),
				};
			}
			case 'complained': {
				// Prefer Message-ID attribution; fall back to the recipient
				// address (RFC 5965 §3.2) so a Gmail-redacted FBL still
				// suppresses the complainer. Drop only when neither is present.
				if (payload.messageId) {
					return {
						kind: 'email.complained',
						providerMessageId: payload.messageId,
						at: payload.timestamp,
					};
				}
				if (payload.recipient) {
					return {
						kind: 'email.complained',
						recipient: payload.recipient,
						at: payload.timestamp,
					};
				}
				return null;
			}
			case 'sent': {
				if (!payload.messageId) return null;
				return {
					kind: 'email.sent',
					providerMessageId: payload.messageId,
					at: payload.timestamp ?? Date.now(),
				};
			}
			case 'inbound.received': {
				if (!payload.inboundPayload) return null;
				// Delegate envelope normalization to @owlat/channels so the
				// MTA SMTP server and webhook share one parser.
				const normalized = getInboundChannelAdapter('mta').parseInbound(payload);
				return { kind: 'inbound.received', mail: normalized };
			}
			case 'org.circuit_breaker': {
				return {
					kind: 'internal.circuit_breaker_tripped',
					message: payload.message ?? 'high bounce rate',
					...(payload.bounceRate !== undefined ? { bounceRate: payload.bounceRate } : {}),
				};
			}
			case 'dkim.rotated': {
				if (
					!payload.domain ||
					!payload.selector ||
					!payload.dnsRecord ||
					(payload.phase !== 'pending' && payload.phase !== 'activated')
				) {
					return null;
				}
				return {
					kind: 'internal.dkim_rotated',
					domain: payload.domain,
					selector: payload.selector,
					dnsRecord: payload.dnsRecord,
					phase: payload.phase,
				};
			}
			case 'campaign.complaint_rate': {
				return {
					kind: 'internal.campaign_complaint_rate',
					message: payload.message ?? 'campaign complaint rate exceeded threshold',
					...(payload.campaignId ? { campaignId: payload.campaignId } : {}),
					...(payload.complaintRate !== undefined ? { complaintRate: payload.complaintRate } : {}),
				};
			}
			case 'ip.blocklisted':
			case 'ip.delisted':
			case 'ip.warming_complete':
			case 'all_ips_blocked': {
				const subkind = IP_EVENT_SUBKIND[payload.event]!;
				return {
					kind: 'internal.ip_event',
					subkind,
					...(payload.ip ? { ip: payload.ip } : {}),
					...(payload.blocklists ? { blocklists: payload.blocklists } : {}),
					...(payload.severity ? { severity: payload.severity } : {}),
					...(payload.message ? { message: payload.message } : {}),
				};
			}
			default:
				return null;
		}
	},
};
