'use node';

import { createHmac, timingSafeEqual } from 'crypto';
import { getOptional } from '../lib/env';
import { UNSUBSCRIBE_TOKEN_MAX_AGE_MS } from '../lib/constants';

/**
 * Signed contact-token codec shared by the unsubscribe and preference-center
 * flows. Token shape: `{contactId}:{timestamp}:{signature}`, where the signature
 * is HMAC-SHA256 (UNSUBSCRIBE_SECRET) over `{prefix}{contactId}:{timestamp}`.
 *
 * `prefix` namespaces the payload so a token minted for one purpose can't be
 * replayed against another — unsubscribe uses '' and preferences uses 'pref:'.
 * (The click-tracking signer uses a different secret and format and stays
 * separate, in delivery/sendComposition.)
 */
function getContactTokenSecret(): string {
	const secret = getOptional('UNSUBSCRIBE_SECRET');
	if (!secret) {
		throw new Error('UNSUBSCRIBE_SECRET environment variable is required');
	}
	return secret;
}

export interface ContactTokenResult {
	contactId: string;
	valid: boolean;
	reason?: string;
}

/** Mint a signed contact token namespaced by `prefix`. */
export function makeContactToken(prefix: string, contactId: string): string {
	const timestamp = Date.now().toString();
	const data = `${prefix}${contactId}:${timestamp}`;
	const signature = createHmac('sha256', getContactTokenSecret()).update(data).digest('base64url');
	return `${contactId}:${timestamp}:${signature}`;
}

/** Validate a signed contact token minted with the same `prefix`. */
export function verifyContactToken(
	prefix: string,
	token: string,
	maxAgeMs: number = UNSUBSCRIBE_TOKEN_MAX_AGE_MS,
): ContactTokenResult {
	try {
		const parts = token.split(':');
		if (parts.length !== 3) {
			return { contactId: '', valid: false, reason: 'invalid_format' };
		}

		const [contactId, timestamp, signature] = parts;
		if (!contactId || !timestamp || !signature) {
			return { contactId: '', valid: false, reason: 'missing_parts' };
		}

		const tokenTime = parseInt(timestamp, 10);
		if (isNaN(tokenTime) || Date.now() - tokenTime > maxAgeMs) {
			return { contactId, valid: false, reason: 'expired' };
		}

		const data = `${prefix}${contactId}:${timestamp}`;
		const expectedSignature = createHmac('sha256', getContactTokenSecret()).update(data).digest('base64url');

		const sigBuffer = Buffer.from(signature);
		const expectedBuffer = Buffer.from(expectedSignature);
		if (sigBuffer.length !== expectedBuffer.length || !timingSafeEqual(sigBuffer, expectedBuffer)) {
			return { contactId, valid: false, reason: 'invalid_signature' };
		}

		return { contactId, valid: true };
	} catch {
		return { contactId: '', valid: false, reason: 'parse_error' };
	}
}
