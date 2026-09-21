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
 *
 * H2 cross-tenant guard: when the stored key is bound to an owning organization
 * (`organizationId`), it may ONLY sign for a job from that same organization.
 * A job from a different tenant is refused the key and ships UNSIGNED rather than
 * being signed under another tenant's DKIM identity — so an org can never spoof
 * a domain it does not own with a signature that authenticates as that domain.
 * Legacy/env-seeded keys with no recorded owner stay usable by any org for
 * backward compatibility until they are re-registered with an owner.
 *
 * Master-key-only sentinel orgs (`postbox`, `system`) are EXEMPT from the
 * ownership refusal: these ids are only reachable with the master credential
 * (`/send/postbox` and `/send/system` require `isMasterKey`, and `/send` rejects
 * `organizationId: 'postbox'` — see routes/send.ts), so a tenant can never
 * present them. In-app Postbox dispatch sends `organizationId: 'postbox'` with
 * the mailbox's own domain as `dkimDomain`; once that domain is re-registered
 * with its real owning org, refusing the sentinel would strip DKIM from every
 * personal message. Exempting the sentinels keeps that primary send path signed
 * while still blocking real cross-tenant spoofing.
 */
const MASTER_KEY_ONLY_SENTINEL_ORGS = new Set(['postbox', 'system']);

export async function getDkimOptions(
	redis: Redis,
	domain: string,
	organizationId?: string
): Promise<DkimSigningKey | undefined> {
	const key = await getDkimConfig(redis, domain.toLowerCase());
	if (!key) {
		logger.warn({ domain }, 'No DKIM key configured for domain');
		return undefined;
	}

	if (
		key.organizationId &&
		organizationId &&
		key.organizationId !== organizationId &&
		!MASTER_KEY_ONLY_SENTINEL_ORGS.has(organizationId)
	) {
		logger.warn(
			{ domain, keyOrganizationId: key.organizationId, jobOrganizationId: organizationId },
			'DKIM key organization mismatch — refusing to sign with another tenant’s key'
		);
		return undefined;
	}

	return {
		domainName: domain.toLowerCase(),
		keySelector: key.selector,
		privateKey: key.privateKey,
	};
}
