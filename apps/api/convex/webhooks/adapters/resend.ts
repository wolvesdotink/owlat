/**
 * Resend webhook adapter — verifies Svix HMAC signatures and parses
 * provider events into InboundEvent. See CONTEXT.md "Inbound adapter".
 *
 * The adapter only emits InboundEvents for the events Owlat acts on today
 * (bounce + complaint). Other Resend events (sent/delivered/
 * delivery_delayed/opened/clicked) are acknowledged but parseEvent returns
 * null for them — the Send lifecycle records `sent` at workpool dispatch
 * and open/click tracking comes from Owlat's own tracking pixel, not
 * Resend's counters. The dispatcher would handle them correctly if we
 * decided to consume them; that's a future decision.
 */

import { getOptional } from '../../lib/env';
import {
	constantTimeEqual,
	hmacSha256Base64,
} from '../security';
import { classifyBounceMessage } from '@owlat/shared/bounceClassification';
import type { InboundAdapter } from '../pipeline';
import type { InboundEvent } from '../types';

type ResendEventType =
	| 'email.sent'
	| 'email.delivered'
	| 'email.delivery_delayed'
	| 'email.complained'
	| 'email.bounced'
	| 'email.opened'
	| 'email.clicked';

interface ResendWebhookPayload {
	type: ResendEventType;
	created_at: string;
	data: {
		created_at: string;
		email_id: string;
		from: string;
		to: string[];
		subject: string;
		bounce?: { message: string };
		click?: {
			ipAddress: string;
			link: string;
			timestamp: string;
			userAgent: string;
		};
	};
}

const SVIX_TIMESTAMP_TOLERANCE_SECONDS = 300; // 5 minutes

/**
 * Classify a Resend bounce message into hard vs. soft via the shared free-text
 * classifier (single source — the MTA bounce engine uses the same patterns).
 */
export function classifyResendBounce(bounceMessage: string): 'hard' | 'soft' {
	return classifyBounceMessage(bounceMessage);
}

export async function verifySvixHeaders(
	body: string,
	svixId: string,
	svixTimestamp: string,
	svixSignature: string,
	secret: string,
	nowSeconds: number = Math.floor(Date.now() / 1000)
): Promise<boolean> {
	const timestampSeconds = parseInt(svixTimestamp, 10);
	if (isNaN(timestampSeconds)) return false;
	if (Math.abs(nowSeconds - timestampSeconds) > SVIX_TIMESTAMP_TOLERANCE_SECONDS) {
		return false;
	}

	const signedContent = `${svixId}.${svixTimestamp}.${body}`;
	const secretBase64 = secret.startsWith('whsec_') ? secret.slice(6) : secret;

	let secretBinary: Uint8Array;
	try {
		secretBinary = Uint8Array.from(atob(secretBase64), (c) => c.charCodeAt(0));
	} catch {
		return false;
	}

	const expectedSignature = await hmacSha256Base64(
		secretBinary,
		signedContent
	);

	// The svix-signature header may carry multiple signatures
	// ("v1,<sig1> v1,<sig2>") — accept the request if any one matches.
	const signatures = svixSignature.split(' ');
	for (const sig of signatures) {
		const parts = sig.split(',');
		if (parts.length < 2) continue;
		const sigValue = parts.slice(1).join(',');
		if (constantTimeEqual(sigValue, expectedSignature)) {
			return true;
		}
	}

	return false;
}

export const resendAdapter: InboundAdapter = {
	source: 'resend',

	async verifySignature(request, rawBody) {
		const secret = getOptional('RESEND_WEBHOOK_SECRET');
		if (!secret) {
			return {
				ok: false,
				status: 503,
				reason:
					'Webhook endpoint is not configured securely (missing RESEND_WEBHOOK_SECRET)',
			};
		}

		const svixId = request.headers.get('svix-id');
		const svixTimestamp = request.headers.get('svix-timestamp');
		const svixSignature = request.headers.get('svix-signature');

		if (!svixId || !svixTimestamp || !svixSignature) {
			return {
				ok: false,
				status: 401,
				reason: 'Missing Svix signature headers',
			};
		}

		const isValid = await verifySvixHeaders(
			rawBody,
			svixId,
			svixTimestamp,
			svixSignature,
			secret
		);
		if (!isValid) {
			return { ok: false, status: 401, reason: 'Invalid webhook signature' };
		}

		return { ok: true };
	},

	parseEvent(rawBody): InboundEvent | null {
		const payload = JSON.parse(rawBody) as ResendWebhookPayload;
		const at = new Date(payload.created_at).getTime();
		const providerMessageId = payload.data.email_id;

		switch (payload.type) {
			case 'email.bounced': {
				const bounceMessage = payload.data.bounce?.message ?? '';
				return {
					kind: 'email.bounced',
					providerMessageId,
					at,
					bounceType: classifyResendBounce(bounceMessage),
					...(bounceMessage ? { bounceMessage } : {}),
				};
			}
			case 'email.complained':
				return { kind: 'email.complained', providerMessageId, at };
			// Other Resend events are acknowledged but not consumed today; see
			// module docstring.
			default:
				return null;
		}
	},
};
