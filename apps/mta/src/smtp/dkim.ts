/**
 * DKIM key management for outbound signing.
 *
 * Resolves per-domain DKIM private keys from the Redis-backed store. The signing
 * itself — relaxed/relaxed canonicalization, body hashing, oversigning the
 * headers a replay could add and the `t=` timestamp — lives in `@owlat/mail-message`'s
 * `signMessage(raw, key)`, which signs over the composed message BYTES on the
 * ONE shared canonicalizer (locked decision U4). The sender signs once per job
 * and ships byte-identical signed bytes across MX retries. This module owns only
 * the key lookup; the returned {@link DkimSigningKey} is the exact shape
 * `signMessage` consumes.
 */

import { createPrivateKey } from 'crypto';
import type Redis from 'ioredis';
import type { DkimSigningKey } from '@owlat/mail-message';
import type { DkimKeyConfig } from '../types.js';
import { dnsRecordFromPrivateKey, getDkimConfig, markDkimKeyPublished } from './dkimStore.js';
import { isPendingDnsPublished, type TxtResolver } from './dkimRotation.js';
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

function isForeignTenantKey(key: DkimKeyConfig, organizationId: string | undefined): boolean {
	return Boolean(
		key.organizationId &&
		organizationId &&
		key.organizationId !== organizationId &&
		!MASTER_KEY_ONLY_SENTINEL_ORGS.has(organizationId)
	);
}

function signingKey(domain: string, key: DkimKeyConfig): DkimSigningKey {
	return { domainName: domain, keySelector: key.selector, privateKey: key.privateKey };
}

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

	if (isForeignTenantKey(key, organizationId)) {
		logger.warn(
			{ domain, keyOrganizationId: key.organizationId, jobOrganizationId: organizationId },
			'DKIM key organization mismatch — refusing to sign with another tenant’s key'
		);
		return undefined;
	}

	return signingKey(domain.toLowerCase(), key);
}

/**
 * Why a send that requires a signature has no key to sign with. Bounded, because
 * it labels a metric and travels to Convex in the health snapshot.
 *
 *  - `no_key`        nothing is stored for the domain (Redis lost or never seeded);
 *  - `org_mismatch`  the stored key belongs to another organization;
 *  - `unreadable`    the sealed key does not open (a different `MTA_SECRET`);
 *  - `unusable`      the PEM does not parse as an RSA private key;
 *  - `unpublished`   the MTA generated the key and its DNS record is not live yet;
 *  - `sign_failed`   signing this message threw.
 */
export const DKIM_UNAVAILABLE_CAUSES = [
	'no_key',
	'org_mismatch',
	'unreadable',
	'unusable',
	'unpublished',
	'sign_failed',
] as const;
export type DkimUnavailableCause = (typeof DKIM_UNAVAILABLE_CAUSES)[number];

export type RequiredDkimKey =
	| { kind: 'key'; key: DkimSigningKey }
	| { kind: 'unavailable'; cause: DkimUnavailableCause };

/**
 * How long a failed publication check is trusted before DNS is asked again. A
 * held campaign re-enters dispatch message by message; without this every one
 * of them would query the selector.
 */
const UNPUBLISHED_RECHECK_MS = 60_000;
const unpublishedUntil = new Map<string, number>();

/** Forget cached publication verdicts (tests). */
export function clearDkimPublicationCache(): void {
	unpublishedUntil.clear();
}

/**
 * Resolve the key for a send whose sending domain Convex says is owed a
 * signature, refusing every key that would not produce one receivers can verify.
 *
 * A key the MTA generated itself is used only once its public record answers at
 * `<selector>._domainkey.<domain>`: after a lost key is regenerated, DNS still
 * publishes the old public key, and mail signed with the new one fails DKIM at
 * every receiver. The first successful check removes the mark for good.
 */
export async function resolveRequiredDkimKey(
	redis: Redis,
	domain: string,
	organizationId: string | undefined,
	resolveTxt?: TxtResolver
): Promise<RequiredDkimKey> {
	const name = domain.toLowerCase();
	let key: DkimKeyConfig | null;
	try {
		key = await getDkimConfig(redis, name);
	} catch (err) {
		logger.error({ err, domain: name }, 'DKIM key for domain cannot be opened');
		return { kind: 'unavailable', cause: 'unreadable' };
	}
	if (!key) return { kind: 'unavailable', cause: 'no_key' };
	if (isForeignTenantKey(key, organizationId))
		return { kind: 'unavailable', cause: 'org_mismatch' };
	try {
		if (createPrivateKey(key.privateKey).asymmetricKeyType !== 'rsa') {
			return { kind: 'unavailable', cause: 'unusable' };
		}
	} catch {
		return { kind: 'unavailable', cause: 'unusable' };
	}
	if (key.awaitingDnsSince !== undefined) {
		const cacheKey = `${name}|${key.selector}`;
		if ((unpublishedUntil.get(cacheKey) ?? 0) > Date.now()) {
			return { kind: 'unavailable', cause: 'unpublished' };
		}
		const published = await isPendingDnsPublished(
			name,
			key.selector,
			dnsRecordFromPrivateKey(key.privateKey),
			resolveTxt
		);
		if (!published) {
			unpublishedUntil.set(cacheKey, Date.now() + UNPUBLISHED_RECHECK_MS);
			return { kind: 'unavailable', cause: 'unpublished' };
		}
		unpublishedUntil.delete(cacheKey);
		await markDkimKeyPublished(redis, name, key.selector);
	}
	return { kind: 'key', key: signingKey(name, key) };
}

/** A required signature could not be produced; the send must not go out. */
export class DkimSignatureUnavailableError extends Error {
	constructor(
		readonly domain: string,
		readonly reason: DkimUnavailableCause
	) {
		super(`DKIM signature unavailable for ${domain} (${reason})`);
		this.name = 'DkimSignatureUnavailableError';
	}
}
