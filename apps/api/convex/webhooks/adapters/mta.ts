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
import { isMtaWebhookEvent } from '@owlat/shared/mtaWebhookEvent';
import type { WorkerEnvelopeInput } from '../../delivery/workerEnvelope';

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function isPostmasterProtocolPayload(rawBody: string): boolean {
	try {
		const payload = JSON.parse(rawBody) as unknown;
		return (
			isRecord(payload) &&
			(payload['event'] === 'postmaster.authorize_domain' ||
				payload['event'] === 'postmaster.stats')
		);
	} catch {
		return false;
	}
}

function postmasterAcknowledgement(event: InboundEvent, dispatchResult: unknown): Response {
	const authorized = isRecord(dispatchResult) && dispatchResult['authorized'] === true;
	const retained = isRecord(dispatchResult) && dispatchResult['ingested'] === true;
	return new Response(
		JSON.stringify({
			success: true,
			kind: event.kind,
			disposition: authorized ? 'accepted_authorized' : 'ignored_unowned',
			retained,
		}),
		{ status: 200, headers: { 'Content-Type': 'application/json' } }
	);
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

const ROUTING_REENTRY_DISPOSITION_STATUS = {
	invalid_token: 409,
	binding_mismatch: 409,
	message_mismatch: 409,
	expired: 409,
	snapshot_not_found: 409,
	enqueued: 200,
	duplicate: 200,
	terminal: 200,
	deadline_expired: 200,
	retry_exhausted: 200,
} as const;

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
	shouldStoreRawPayload: (rawBody) => !isPostmasterProtocolPayload(rawBody),

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
		const parsed: unknown = JSON.parse(rawBody);
		if (!isMtaWebhookEvent(parsed)) return null;
		const payload = parsed;
		switch (payload.event) {
			case 'routing.reentry': {
				const reentry = isRecord(payload.routingReentry) ? payload.routingReentry : null;
				const retryState =
					reentry && isRecord(reentry['retryState']) ? reentry['retryState'] : null;
				// The optional fields are part of the callback digest issued by
				// `issueSnapshot`, so they must round-trip byte-for-byte. Dropping
				// them turns every acceptance-reconciliation re-entry into a
				// permanent `binding_mismatch` and strands the Send in `queued`.
				const reentryWorkAttemptId = retryState?.['workAttemptId'];
				const acceptanceReconciliation = retryState?.['acceptanceReconciliation'];
				if (
					!payload.messageId ||
					typeof payload.routingReentryToken !== 'string' ||
					payload.routingReentryToken.length < 1 ||
					payload.routingReentryToken.length > 512 ||
					typeof payload.workAttemptId !== 'string' ||
					payload.workAttemptId.length < 1 ||
					payload.workAttemptId.length > 128 ||
					!reentry ||
					!isRecord(reentry['envelopeInput']) ||
					!retryState ||
					typeof retryState['attempt'] !== 'number' ||
					!Number.isInteger(retryState['attempt']) ||
					retryState['attempt'] < 1 ||
					retryState['attempt'] > 9 ||
					typeof retryState['startedAt'] !== 'number' ||
					!Number.isFinite(retryState['startedAt']) ||
					retryState['idempotencyKey'] !== payload.messageId ||
					(reentryWorkAttemptId !== undefined &&
						(typeof reentryWorkAttemptId !== 'string' ||
							reentryWorkAttemptId.length < 1 ||
							reentryWorkAttemptId.length > 128)) ||
					(acceptanceReconciliation !== undefined &&
						typeof acceptanceReconciliation !== 'boolean') ||
					(payload.routingReentryReason !== 'routing_lease_stale' &&
						payload.routingReentryReason !== 'circuit_breaker_changed' &&
						payload.routingReentryReason !== 'warming_capacity_changed')
				)
					return null;
				return {
					kind: 'internal.routing_reentry',
					providerMessageId: payload.messageId,
					token: payload.routingReentryToken,
					workAttemptId: payload.workAttemptId,
					envelopeInput: reentry['envelopeInput'] as WorkerEnvelopeInput,
					retryState: {
						attempt: retryState['attempt'],
						startedAt: retryState['startedAt'],
						idempotencyKey: payload.messageId,
						...(typeof reentryWorkAttemptId === 'string'
							? { workAttemptId: reentryWorkAttemptId }
							: {}),
						...(typeof acceptanceReconciliation === 'boolean' ? { acceptanceReconciliation } : {}),
					},
					reason: payload.routingReentryReason,
				};
			}
			case 'postmaster.authorize_domain': {
				if (!payload.domain) return null;
				return {
					kind: 'internal.postmaster_authorize_domain',
					domain: payload.domain,
				};
			}
			case 'bounced': {
				if (!payload.messageId) return null;
				return {
					kind: 'email.bounced',
					providerMessageId: payload.messageId,
					at: payload.timestamp,
					bounceType: payload.bounceType === 'hard' ? 'hard' : 'soft',
					...(payload.message ? { bounceMessage: payload.message } : {}),
					...(payload.deliveryDomain ? { deliveryDomain: payload.deliveryDomain } : {}),
					providerType: 'mta',
				};
			}
			case 'failed': {
				// Terminal, NON-bounce failure (for example a screened message or an
				// ambiguous post-DATA drop). Map to
				// the `failed` send status — distinct from `bounced`, so the dispatcher
				// applies NO recipient suppression and NO reputation penalty.
				if (!payload.messageId) return null;
				const errorCode =
					typeof payload.errorCode === 'string' &&
					payload.errorCode.length > 0 &&
					payload.errorCode.length <= 128
						? payload.errorCode
						: 'ambiguous_post_data';
				return {
					kind: 'email.failed',
					providerMessageId: payload.messageId,
					at: payload.timestamp ?? Date.now(),
					errorMessage: payload.message ?? 'Delivery failed (ambiguous post-DATA drop)',
					errorCode,
					...(payload.deliveryDomain ? { deliveryDomain: payload.deliveryDomain } : {}),
					providerType: 'mta',
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
						providerType: 'mta',
						...(payload.deliveryDomain ? { deliveryDomain: payload.deliveryDomain } : {}),
					};
				}
				if (payload.recipient) {
					return {
						kind: 'email.complained',
						recipient: payload.recipient,
						at: payload.timestamp,
						providerType: 'mta',
						...(payload.deliveryDomain ? { deliveryDomain: payload.deliveryDomain } : {}),
					};
				}
				return null;
			}
			case 'sent': {
				if (!payload.messageId) return null;
				return {
					// The MTA emits this only after the destination SMTP server has
					// accepted DATA. POST /send queue acceptance is recorded separately
					// by the worker as `sent`; this is the truthful delivered denominator.
					kind: 'email.delivered',
					providerMessageId: payload.messageId,
					at: payload.timestamp ?? Date.now(),
					providerType: 'mta',
					...(payload.organizationId ? { organizationId: payload.organizationId } : {}),
					...(payload.recipient ? { recipient: payload.recipient } : {}),
					...(payload.destinationProvider
						? { destinationProvider: payload.destinationProvider }
						: {}),
					...(payload.primarySendingDomain
						? { primarySendingDomain: payload.primarySendingDomain }
						: {}),
					...(payload.deliveryDomain ? { deliveryDomain: payload.deliveryDomain } : {}),
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
					eventId: payload.eventId,
					message: payload.message,
					campaignId: payload.campaignId,
					complaintRate: payload.complaintRate,
					at: payload.timestamp,
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
			case 'postmaster.stats': {
				if (
					!payload.domain ||
					!payload.date ||
					typeof payload.userReportedSpamRatio !== 'number' ||
					!Number.isFinite(payload.userReportedSpamRatio) ||
					payload.userReportedSpamRatio < 0 ||
					payload.userReportedSpamRatio > 1
				) {
					return null;
				}
				return {
					kind: 'internal.postmaster_stats',
					domain: payload.domain,
					date: payload.date,
					userReportedSpamRatio: payload.userReportedSpamRatio,
					fetchedAt: payload.timestamp,
				};
			}
			default:
				return null;
		}
	},

	successResponse(event, dispatchResult) {
		if (event.kind === 'internal.routing_reentry') {
			const disposition = isRecord(dispatchResult) ? dispatchResult['disposition'] : undefined;
			const status =
				typeof disposition === 'string' && disposition in ROUTING_REENTRY_DISPOSITION_STATUS
					? ROUTING_REENTRY_DISPOSITION_STATUS[
							disposition as keyof typeof ROUTING_REENTRY_DISPOSITION_STATUS
						]
					: 500;
			// The MTA's protected outbox treats every non-2xx as durable retry /
			// operator-visible work. Only dispositions that atomically enqueued a
			// successor or observed a terminal/idempotent Send may be acknowledged.
			return new Response(
				JSON.stringify({ success: status === 200, disposition: disposition ?? 'invalid_result' }),
				{ status, headers: { 'Content-Type': 'application/json' } }
			);
		}
		if (
			event.kind === 'internal.postmaster_authorize_domain' ||
			event.kind === 'internal.postmaster_stats'
		) {
			return postmasterAcknowledgement(event, dispatchResult);
		}
		return new Response(JSON.stringify({ success: true, kind: event.kind }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	},
};
