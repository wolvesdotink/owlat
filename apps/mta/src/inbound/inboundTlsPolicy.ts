/**
 * Dynamic inbound TLS policy shared by the SMTP gate and the authenticated
 * control-plane route. Missing or unreadable state fails closed: TLS remains
 * required until an owner/admin explicitly disables it again.
 */

import type Redis from 'ioredis';
import type { SmtpReply } from '@owlat/smtp-listener';
import { logger } from '../monitoring/logger.js';

const INBOUND_TLS_REQUIRED_KEY = 'mta:inbound-tls-required';

export async function isInboundTlsRequired(redis: Redis): Promise<boolean> {
	try {
		return (await redis.get(INBOUND_TLS_REQUIRED_KEY)) !== '0';
	} catch (err) {
		logger.error({ err }, 'Inbound TLS policy lookup failed — requiring TLS');
		return true;
	}
}

export async function setInboundTlsRequired(redis: Redis, isRequired: boolean): Promise<void> {
	await redis.set(INBOUND_TLS_REQUIRED_KEY, isRequired ? '1' : '0');
	logger.info({ isRequired }, 'Inbound TLS policy updated');
}

/**
 * Permanent, sender-visible rejection for a plaintext inbound SMTP transaction.
 *
 * The in-house listener rejects a MAIL FROM by returning a structured
 * {@link SmtpReply}. `{ code: 550, enhanced: '5.7.10', text: … }` serializes to
 * `550 5.7.10 Encryption needed: …` — byte-identical to the old smtp-server
 * error whose message embedded the `5.7.10` enhanced code with `responseCode`
 * 550 (RFC 3207 §4 / RFC 3463).
 */
export function inboundTlsRequiredReply(): SmtpReply {
	return {
		code: 550,
		enhanced: '5.7.10',
		text: 'Encryption needed: this server requires STARTTLS for inbound delivery',
	};
}
