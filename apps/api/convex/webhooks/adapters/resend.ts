/**
 * Resend webhook parser — turns provider events into InboundEvent. See
 * CONTEXT.md "Inbound adapter".
 *
 * Authentication is NOT this module's decision: the bundle declares the `svix`
 * scheme (with its tolerance) and the host verifier registry enforces it
 * (`../providerVerifierRegistry.ts`). `verifySvixHeaders` below is that scheme's
 * reusable inner half, which the registry calls with the DECLARED tolerance.
 *
 * The adapter only emits InboundEvents for the events Owlat acts on today
 * (bounce + complaint). Other Resend events (sent/delivered/
 * delivery_delayed/opened/clicked) are acknowledged but parseEvent returns
 * null for them — the Send lifecycle records `sent` at workpool dispatch
 * and open/click tracking comes from Owlat's own tracking pixel, not
 * Resend's counters. The dispatcher would handle them correctly if we
 * decided to consume them; that's a future decision.
 */

import { constantTimeEqual, hmacSha256Base64 } from '../security';
import { classifyBounceMessage } from '@owlat/shared/bounceClassification';
import type { InboundParser } from '../pipeline';
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

/**
 * @param toleranceSeconds - How far the signed timestamp may sit from now, in
 * either direction. The host verifier registry passes the tolerance the `svix`
 * bundle DECLARES (clamped), so the declaration is what is enforced rather than
 * a constant that happens to agree with it today; the default is Svix's own
 * recommended window for a caller that declares nothing.
 */
export async function verifySvixHeaders(
	body: string,
	svixId: string,
	svixTimestamp: string,
	svixSignature: string,
	secret: string,
	nowSeconds: number = Math.floor(Date.now() / 1000),
	toleranceSeconds: number = SVIX_TIMESTAMP_TOLERANCE_SECONDS
): Promise<boolean> {
	const timestampSeconds = parseInt(svixTimestamp, 10);
	if (isNaN(timestampSeconds)) return false;
	if (Math.abs(nowSeconds - timestampSeconds) > toleranceSeconds) {
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

	const expectedSignature = await hmacSha256Base64(secretBinary, signedContent);

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

export const resendAdapter: InboundParser<'resend'> = {
	source: 'resend',

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
