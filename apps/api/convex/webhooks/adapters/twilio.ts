/**
 * Twilio SMS webhook adapter — verifies HMAC-SHA1 over the canonical
 * "URL + sorted form params" string per Twilio's spec, and parses the
 * URL-encoded form payload into a channel.received event. See CONTEXT.md
 * "Inbound adapter".
 *
 * Twilio does not include a timestamp in its signature, so replay
 * protection is not possible at this layer. Acceptable for inbound
 * channels because the worst-case effect is a duplicate inbound message,
 * not a forged state transition.
 *
 * Twilio expects a TwiML XML response on success; `successResponse`
 * supplies the empty-Response envelope (no auto-reply) so wire behavior
 * matches the pre-deepening handler.
 *
 * https://www.twilio.com/docs/usage/security#validating-requests
 */

import { getOptional } from '../../lib/env';
import { constantTimeEqual, hmacSha1Base64, missingSecretResult } from '../security';
import type { InboundAdapter } from '../pipeline';
import type { InboundEvent } from '../types';

/**
 * Reconstruct the Twilio canonical validation string — full request URL
 * followed by every form param concatenated in alphabetical order (key
 * immediately followed by value, no separator).
 */
export function twilioValidationString(url: string, params: Record<string, string>): string {
	const keys = Object.keys(params).sort();
	let s = url;
	for (const k of keys) s += k + params[k];
	return s;
}

function parseFormParams(rawBody: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of new URLSearchParams(rawBody).entries()) {
		out[k] = v;
	}
	return out;
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

	async verifySignature(request, rawBody) {
		const authToken = getOptional('TWILIO_AUTH_TOKEN');
		if (!authToken) {
			return missingSecretResult('TWILIO_AUTH_TOKEN');
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
