/**
 * Meta (WhatsApp Business) webhook adapter — verifies HMAC-SHA256 of the
 * raw body against `x-hub-signature-256` (after stripping the `sha256=`
 * prefix), and parses the deeply-nested `entry/changes/value/messages`
 * envelope into a `channel.received` event with `channel: 'whatsapp'`.
 *
 * Meta's webhook subscriptions are activated by a *GET verification
 * challenge* that doesn't belong on the inbound-event pipeline (the
 * pipeline is POST-only). `handleMetaChallenge` is exported as a sibling
 * helper that the outer HTTP shell calls *before* `runInboundPipeline`
 * when `request.method === 'GET'`.
 *
 * https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks
 */

import { getOptional } from '../../lib/env';
import { constantTimeEqual, hmacSha256Hex } from '../security';
import { logError } from '../../lib/runtimeLog';
import type { InboundAdapter } from '../pipeline';
import type { InboundEvent } from '../types';

/**
 * Verify a Meta `x-hub-signature-256` header against the raw body.
 * Header format is `sha256=<hex>`. Returns false on missing prefix or
 * mismatched signature.
 */
export async function verifyMetaSignature(
	rawBody: string,
	headerValue: string,
	appSecret: string
): Promise<boolean> {
	if (!headerValue.startsWith('sha256=')) return false;
	const provided = headerValue.slice('sha256='.length);
	const expected = await hmacSha256Hex(appSecret, rawBody);
	return constantTimeEqual(expected, provided);
}

interface MetaPayload {
	entry?: Array<{
		changes?: Array<{
			value?: {
				messages?: Array<{
					from?: string;
					id?: string;
					text?: { body?: string };
					image?: { url?: string };
					document?: { url?: string };
				}>;
				contacts?: Array<{ profile?: { name?: string } }>;
			};
		}>;
	}>;
}

const META_SUCCESS_BODY = 'OK';

export const metaAdapter: InboundAdapter = {
	source: 'meta',

	async verifySignature(request, rawBody) {
		const appSecret = getOptional('META_APP_SECRET');
		if (!appSecret) {
			return {
				ok: false,
				status: 503,
				reason:
					'Webhook endpoint is not configured securely (missing META_APP_SECRET)',
			};
		}

		const signature = request.headers.get('x-hub-signature-256');
		if (!signature) {
			return {
				ok: false,
				status: 401,
				reason: 'Missing X-Hub-Signature-256 header',
			};
		}

		const valid = await verifyMetaSignature(rawBody, signature, appSecret);
		if (!valid) {
			return { ok: false, status: 401, reason: 'Invalid Meta signature' };
		}

		return { ok: true };
	},

	parseEvent(rawBody): InboundEvent | null {
		const payload = JSON.parse(rawBody) as MetaPayload;
		const value = payload.entry?.[0]?.changes?.[0]?.value;
		const msg = value?.messages?.[0];

		// Meta sends status updates too — acknowledge with no event when no
		// messages are present.
		if (!msg) return null;

		const from = msg.from ?? '';
		const text = msg.text?.body ?? '';
		const messageId = msg.id ?? '';
		const mediaUrl = msg.image?.url ?? msg.document?.url;
		const profileName = value?.contacts?.[0]?.profile?.name;

		if (!from) return null;

		return {
			kind: 'channel.received',
			channel: 'whatsapp',
			from,
			content: {
				text,
				...(mediaUrl ? { mediaUrl } : {}),
			},
			...(messageId ? { externalMessageId: messageId } : {}),
			metadata: { profileName },
		};
	},

	successResponse() {
		return new Response(META_SUCCESS_BODY, { status: 200 });
	},
};

/**
 * Meta GET verification challenge handler. Runs in the outer HTTP shell
 * *before* `runInboundPipeline`, because the challenge is not an Inbound
 * event — it's a one-shot protocol handshake that Meta uses to confirm
 * webhook ownership when subscriptions are activated.
 *
 * Spec: when `META_VERIFY_TOKEN` matches the `hub.verify_token` query
 * param and `hub.mode === 'subscribe'`, echo back `hub.challenge`.
 */
export function handleMetaChallenge(request: Request): Response {
	const verifyToken = getOptional('META_VERIFY_TOKEN');
	if (!verifyToken) {
		logError(
			'[Meta Webhook] handleMetaChallenge: META_VERIFY_TOKEN is not set'
		);
		return new Response(
			JSON.stringify({ error: 'Webhook endpoint is not configured securely' }),
			{ status: 503, headers: { 'Content-Type': 'application/json' } }
		);
	}

	const url = new URL(request.url);
	const mode = url.searchParams.get('hub.mode');
	const token = url.searchParams.get('hub.verify_token') ?? '';
	const challenge = url.searchParams.get('hub.challenge');

	if (
		mode === 'subscribe' &&
		challenge &&
		constantTimeEqual(token, verifyToken)
	) {
		return new Response(challenge, { status: 200 });
	}
	return new Response('Verification failed', { status: 403 });
}
