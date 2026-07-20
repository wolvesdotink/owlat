/**
 * DKIM key management for outbound signing.
 *
 * Resolves per-domain DKIM private keys from the Redis-backed store. The signing
 * itself — relaxed/relaxed canonicalization, body hashing, oversigning From/
 * Subject/To and the `t=` timestamp — lives in `@owlat/mail-message`'s
 * `signMessage(raw, key)`, which signs over the composed message BYTES on the
 * ONE shared canonicalizer (locked decision U4). The sender signs once per job
 * and ships byte-identical signed bytes across MX retries. This module owns only
 * the key lookup; the returned {@link DkimSigningKey} is the exact shape
 * `signMessage` consumes.
 */

import type Redis from 'ioredis';
import type { DkimSigningKey } from '@owlat/mail-message';
import { getDkimConfig } from './dkimStore.js';
import { logger } from '../monitoring/logger.js';

export type { DkimSigningKey } from '@owlat/mail-message';

/**
 * Resolve the DKIM signing key for a sending domain, or `undefined` when no key
 * is configured (the sender then ships the message UNSIGNED rather than failing
 * — an unsigned message that fails DMARC is recoverable; a missing key is not a
 * delivery error). The pool keys transports by this domain so DANE/TLS profiles
 * never cross signing domains.
 */
export async function getDkimOptions(
	redis: Redis,
	domain: string
): Promise<DkimSigningKey | undefined> {
	const key = await getDkimConfig(redis, domain.toLowerCase());
	if (!key) {
		logger.warn({ domain }, 'No DKIM key configured for domain');
		return undefined;
	}

	return {
		domainName: domain.toLowerCase(),
		keySelector: key.selector,
		privateKey: key.privateKey,
	};
}
