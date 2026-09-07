/**
 * MTA webhook parser — turns owlat-mta service events into InboundEvent. See
 * CONTEXT.md "Inbound adapter".
 *
 * Authentication is NOT this module's decision: the bundle declares the
 * `hmac-timestamp-body` scheme and the host verifier registry enforces it
 * (`../providerVerifierRegistry.ts`). `verifyMtaHeaders` below is the scheme's
 * reusable inner half, and the mailbox route `/webhooks/mta-mailbox` — which is
 * not a provider-feedback surface and so has no bundle — calls it directly.
 *
 * MTA pre-classifies bounces on the sending side (DSN status codes → hard/
 * soft) so the adapter trusts `payload.bounceType` and does no further
 * classification. Postbox routing (`pb-` prefix on messageId) lives in the
 * dispatcher, not here.
 *
 * Events carried by `POST /webhooks/mta` are parsed by `./mtaEventParsers.ts`
 * — an exhaustive registry over `MtaWebhookEventType` (the `../dispatcher.ts`
 * DispatchTable pattern), so a kind added to the wire contract is a compile
 * error there until an entry says what it means. Exactly one kind,
 * `inbound.mailbox.received`, is an explicit documented ignore: the MTA's
 * notifier delivers it to `POST /webhooks/mta-mailbox` (`mail/webhook.ts`),
 * never to this surface.
 */

import { constantTimeEqual, hmacSha256Hex } from '../security';
import type { InboundParser } from '../pipeline';
import type { InboundEvent } from '../types';
import { isMtaWebhookEvent, type ValidatedMtaWebhookEvent } from '@owlat/mta-protocol/webhookEvent';
import { isRecord } from '@owlat/shared';
import { logWarn } from '../../lib/runtimeLog';
import { MTA_EVENT_PARSERS } from './mtaEventParsers';

function isSensitiveInternalPayload(rawBody: string): boolean {
	try {
		const payload = JSON.parse(rawBody) as unknown;
		return (
			isRecord(payload) &&
			(payload['event'] === 'postmaster.authorize_domain' ||
				payload['event'] === 'postmaster.stats' ||
				payload['event'] === 'postmaster.compliance' ||
				payload['event'] === 'deliverability.probe_observed')
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

export const mtaAdapter: InboundParser<'mta'> = {
	source: 'mta',
	shouldStoreRawPayload: (rawBody) => !isSensitiveInternalPayload(rawBody),

	parseEvent(rawBody): InboundEvent | null {
		const parsed: unknown = JSON.parse(rawBody);
		if (!isMtaWebhookEvent(parsed)) {
			// The pipeline answers an empty parse with 200 `{ignored:true}` and the
			// MTA's outbox retires the event — there is no DLQ behind this path
			// (`apps/mta/src/webhooks/dlq.ts` catches transport failures only). A
			// payload the ingress guard refuses must therefore leave a trace, or
			// the discard is indistinguishable from success. Log the discriminator
			// only: internal payloads (postmaster.*, probes) are sensitive.
			const kind =
				isRecord(parsed) && typeof parsed['event'] === 'string'
					? parsed['event'].slice(0, 64)
					: '(missing)';
			logWarn(
				`[mta Webhook] Ingress guard rejected event "${kind}"; acknowledging without dispatch`
			);
			return null;
		}
		// Same lookup-cast shape as `../dispatcher.ts` DISPATCH: the table is
		// total over the union, so the cast only erases the per-key correlation.
		const parse = MTA_EVENT_PARSERS[parsed.event] as (
			payload: ValidatedMtaWebhookEvent
		) => InboundEvent | null;
		return parse(parsed);
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
			event.kind === 'internal.postmaster_stats' ||
			event.kind === 'internal.postmaster_compliance'
		) {
			return postmasterAcknowledgement(event, dispatchResult);
		}
		return new Response(JSON.stringify({ success: true, kind: event.kind }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	},
};
