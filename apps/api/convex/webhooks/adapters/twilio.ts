/**
 * Twilio SMS webhook adapter — verifies HMAC-SHA1 over the canonical
 * "URL + sorted form params" string per Twilio's spec, and parses the
 * URL-encoded form payload into a channel.received event. See CONTEXT.md
 * "Inbound adapter".
 *
 * Twilio does not include a timestamp in its signature, so freshness
 * cannot be checked at this layer. Replay is instead deduped downstream:
 * `webhooks/channels.ts:processInboundChannel` skips a message it already
 * stored under the same `MessageSid` (mapped to `externalMessageId`), so a
 * captured-and-replayed or provider-retried POST is a no-op rather than a
 * duplicate inbound.
 *
 * Twilio expects a TwiML XML response on success; `successResponse`
 * supplies the empty-Response envelope (no auto-reply) so wire behavior
 * matches the pre-deepening handler.
 *
 * https://www.twilio.com/docs/usage/security#validating-requests
 */

import {
	constantTimeEqual,
	hmacSha1Base64,
	parseFormParams,
	urlAndSortedParamsSigningBase,
} from '../security';
import { missingChannelSecretResult, resolveChannelInboundSecret } from '../channelSecrets';
import type { InboundAdapter } from '../pipeline';
import type { InboundEvent } from '../types';

/**
 * Reconstruct the Twilio canonical validation string — full request URL
 * followed by every form param concatenated in alphabetical order (key
 * immediately followed by value, no separator).
 *
 * Delegates to the shared construction in `webhooks/security.ts`; Mandrill
 * signs the identical string under its own key (plan D10).
 */
export function twilioValidationString(url: string, params: Record<string, string>): string {
	return urlAndSortedParamsSigningBase(url, params);
}

/**
 * Verify a Twilio webhook by reconstructing the canonical string
 * (URL + sorted form params) and comparing the HMAC-SHA1 against the
 * provided header signature. Pure function — env access lives in the
 * adapter wrapper.
 */
export async function verifyTwilioRequest(
	url: string,
	rawBody: string,
	headerSignature: string,
	authToken: string
): Promise<boolean> {
	const params = parseFormParams(rawBody);
	const expected = await hmacSha1Base64(authToken, twilioValidationString(url, params));
	return constantTimeEqual(expected, headerSignature);
}

const TWIML_SUCCESS_BODY = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

export const twilioAdapter: InboundAdapter = {
	source: 'twilio',

	async verifySignature(request, rawBody, ctx) {
		// Twilio signs with the SAME account auth token the outbound adapter
		// sends with, so the SMS card's existing "Auth Token" field is the
		// inbound key too — nothing extra to configure.
		const authToken = await resolveChannelInboundSecret(
			'sms',
			'signature',
			'TWILIO_AUTH_TOKEN',
			ctx
		);
		if (!authToken) {
			return missingChannelSecretResult('TWILIO_AUTH_TOKEN', 'SMS channel Auth Token');
		}

		const signature = request.headers.get('x-twilio-signature');
		if (!signature) {
			return {
				ok: false,
				status: 401,
				reason: 'Missing X-Twilio-Signature header',
			};
		}

		const valid = await verifyTwilioRequest(request.url, rawBody, signature, authToken);
		if (!valid) {
			return { ok: false, status: 401, reason: 'Invalid Twilio signature' };
		}

		return { ok: true };
	},

	parseEvent(rawBody): InboundEvent | null {
		const params = parseFormParams(rawBody);
		const from = params['From'] ?? '';
		const text = params['Body'] ?? '';
		const messageSid = params['MessageSid'] ?? '';

		if (!from || !text) {
			throw new Error('Twilio payload missing required fields: From and Body must both be present');
		}

		return {
			kind: 'channel.received',
			channel: 'sms',
			from,
			content: {
				text,
				...(params['MediaUrl0'] ? { mediaUrl: params['MediaUrl0'] } : {}),
			},
			...(messageSid ? { externalMessageId: messageSid } : {}),
			metadata: {
				fromCity: params['FromCity'],
				fromState: params['FromState'],
				fromCountry: params['FromCountry'],
			},
		};
	},

	successResponse() {
		return new Response(TWIML_SUCCESS_BODY, {
			status: 200,
			headers: { 'Content-Type': 'text/xml' },
		});
	},
};
