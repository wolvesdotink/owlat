/**
 * The optional second DKIM key of a sending domain: Ed25519 (RFC 8463).
 *
 * A domain signs with its RSA key always and, once an operator opts it in and
 * the record is published, with this key as well. Receivers that do not know
 * `ed25519-sha256` ignore that signature, so nothing here is required for
 * delivery and nothing here can hold a send (`resolveOptionalEd25519Key`).
 *
 * The key lives in the domain's `mta:dkim:{domain}` hash next to the RSA key
 * (`ED25519_FIELDS`), so deleting the domain, the ownership binding, sealing at
 * rest and the per-process key cache cover both. It is never minted by
 * registration or rotation; only {@link createEd25519Key} adds one.
 */

import { createPublicKey, generateKeyPairSync } from 'crypto';
import { resolveTxt } from 'dns/promises';
import type Redis from 'ioredis';
import { isKeyRecordError, parseDkimKeyRecord, resolveDkimKey } from '@owlat/mail-auth';
import type { DkimSigningKey } from '@owlat/mail-message';
import { getMtaSecretBox } from '../lib/secretBox.js';
import { logger } from '../monitoring/logger.js';
import { ED25519_FIELDS, getDkimConfig, invalidateDkimCache } from './dkimStore.js';
import type { TxtResolver } from './dkimRotation.js';
import { isForeignTenantKey } from './dkimOwnership.js';

const DKIM_PREFIX = 'mta:dkim:';

/**
 * RFC 8410 SubjectPublicKeyInfo prefix of an Ed25519 key. The DKIM record holds
 * only the 32 raw key bytes that follow it (RFC 8463 §4.2), not the SPKI.
 */
const ED25519_SPKI_PREFIX_LENGTH = 12;

/**
 * Selectors of Ed25519 keys start with `e`, RSA selectors with `s`
 * (`rotateKey`, `initiateRotation`), so the two keys can never share a DNS name.
 */
function newEd25519Selector(now: number): string {
	return `e${now}`;
}

/** The DNS TXT value for an Ed25519 private key: `k=ed25519` and the raw key. */
export function ed25519DnsRecordFromPrivateKey(privateKeyPem: string): string {
	const publicKey = createPublicKey(privateKeyPem);
	if (publicKey.asymmetricKeyType !== 'ed25519') {
		throw new Error('not an Ed25519 key');
	}
	const raw = publicKey
		.export({ type: 'spki', format: 'der' })
		.subarray(ED25519_SPKI_PREFIX_LENGTH)
		.toString('base64');
	return `v=DKIM1; k=ed25519; p=${raw}`;
}

export interface Ed25519KeyRecord {
	selector: string;
	dnsRecord: string;
}

export type CreateEd25519KeyResult =
	| ({ kind: 'ok'; created: boolean } & Ed25519KeyRecord)
	| { kind: 'no_rsa_key' }
	| { kind: 'org_mismatch' };

/**
 * Atomic create: refuses a domain with no RSA key (an Ed25519-only hash would
 * look like no key to every reader) or one owned by another organization, and
 * never overwrites an existing Ed25519 key.
 */
const CREATE_SCRIPT = `
local key = KEYS[1]
if redis.call('HEXISTS', key, 'selector') == 0 then return 'no_rsa_key' end
local owner = redis.call('HGET', key, 'organizationId')
if ARGV[1] ~= '' and owner and owner ~= ARGV[1] then return 'org_mismatch' end
if redis.call('HEXISTS', key, ARGV[2]) == 1 then return 'exists' end
redis.call('HSET', key, ARGV[2], ARGV[6], ARGV[3], ARGV[7], ARGV[4], ARGV[8], ARGV[5], ARGV[8])
return 'created'
`;

/**
 * Give a domain an Ed25519 key, or return the one it has. Idempotent: a second
 * call answers the existing selector and record. A new key carries the
 * awaiting-DNS mark, so it signs nothing until its record is seen published.
 */
export async function createEd25519Key(
	redis: Redis,
	domain: string,
	organizationId?: string
): Promise<CreateEd25519KeyResult> {
	const now = Date.now();
	const selector = newEd25519Selector(now);
	const { privateKey } = generateKeyPairSync('ed25519', {
		privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
		publicKeyEncoding: { type: 'spki', format: 'pem' },
	});
	const outcome = (await redis.eval(
		CREATE_SCRIPT,
		1,
		`${DKIM_PREFIX}${domain}`,
		organizationId ?? '',
		ED25519_FIELDS.selector,
		ED25519_FIELDS.privateKey,
		ED25519_FIELDS.awaitingDnsSince,
		ED25519_FIELDS.addedAt,
		selector,
		getMtaSecretBox().seal(privateKey),
		String(now)
	)) as string;
	invalidateDkimCache(domain);

	if (outcome === 'no_rsa_key' || outcome === 'org_mismatch') return { kind: outcome };
	if (outcome === 'created') {
		logger.info({ domain, selector }, 'DKIM Ed25519 key created');
		return {
			kind: 'ok',
			created: true,
			selector,
			dnsRecord: ed25519DnsRecordFromPrivateKey(privateKey),
		};
	}
	const existing = await describeEd25519Key(redis, domain);
	if (!existing) throw new Error(`Ed25519 key for ${domain} cannot be read`);
	return { kind: 'ok', created: false, ...existing };
}

/**
 * Atomic remove with the owner check `CREATE_SCRIPT` makes: a request that
 * names an organization never deletes the key of a domain bound to another
 * one, whatever happened to the domain between the caller's read and now.
 */
const REMOVE_SCRIPT = `
local owner = redis.call('HGET', KEYS[1], 'organizationId')
if ARGV[1] ~= '' and owner and owner ~= ARGV[1] then return -1 end
return redis.call('HDEL', KEYS[1], ARGV[2], ARGV[3], ARGV[4], ARGV[5])
`;

export type RemoveEd25519KeyResult = { kind: 'ok'; removed: boolean } | { kind: 'org_mismatch' };

/**
 * Remove a domain's Ed25519 key and leave the RSA key alone. Idempotent;
 * answers whether a key was removed. Another replica may keep signing with its
 * cached copy until the cache expires, which only adds a signature receivers
 * cannot verify next to the RSA one.
 */
export async function removeEd25519Key(
	redis: Redis,
	domain: string,
	organizationId?: string
): Promise<RemoveEd25519KeyResult> {
	const removed = (await redis.eval(
		REMOVE_SCRIPT,
		1,
		`${DKIM_PREFIX}${domain}`,
		organizationId ?? '',
		ED25519_FIELDS.selector,
		ED25519_FIELDS.privateKey,
		ED25519_FIELDS.awaitingDnsSince,
		ED25519_FIELDS.addedAt
	)) as number;
	if (removed < 0) return { kind: 'org_mismatch' };
	invalidateDkimCache(domain);
	if (removed > 0) logger.info({ domain }, 'DKIM Ed25519 key removed');
	return { kind: 'ok', removed: removed > 0 };
}

/**
 * The domain's Ed25519 selector and record, or undefined when it has none or
 * the key does not open. Never throws: the register answer carries it as an
 * extra, and a broken Ed25519 key must not fail a registration.
 *
 * Reads Redis, not the signing cache: Convex stores this answer as the domain's
 * record list, and a replica's cached copy can be minutes behind a key another
 * replica added or removed.
 */
export async function describeEd25519Key(
	redis: Redis,
	domain: string
): Promise<Ed25519KeyRecord | undefined> {
	try {
		const [selector, sealedPrivateKey] = await redis.hmget(
			`${DKIM_PREFIX}${domain}`,
			ED25519_FIELDS.selector,
			ED25519_FIELDS.privateKey
		);
		if (!selector || !sealedPrivateKey) return undefined;
		const privateKey = getMtaSecretBox().open(sealedPrivateKey);
		return { selector, dnsRecord: ed25519DnsRecordFromPrivateKey(privateKey) };
	} catch (err) {
		logger.warn({ err, domain }, 'DKIM Ed25519 key cannot be read');
		return undefined;
	}
}

/**
 * Record that the Ed25519 record for `selector` was seen published.
 * Compare-and-delete on the selector, so a key replaced since the lookup keeps
 * its own mark.
 */
export async function markEd25519KeyPublished(
	redis: Redis,
	domain: string,
	selector: string
): Promise<void> {
	await redis.eval(
		"if redis.call('HGET', KEYS[1], ARGV[1]) == ARGV[2] then redis.call('HDEL', KEYS[1], ARGV[3]) end return 0",
		1,
		`${DKIM_PREFIX}${domain}`,
		ED25519_FIELDS.selector,
		selector,
		ED25519_FIELDS.awaitingDnsSince
	);
	invalidateDkimCache(domain);
}

/**
 * Whether the selector's TXT record is one a verifier accepts for an
 * `ed25519-sha256` signature and carries exactly this public key. The check is
 * the verifier's own (`resolveDkimKey`): key type, a hash list that allows
 * SHA-256, a service type that allows email, not revoked. The key bytes alone
 * are not enough: a record without `k=` reads as an RSA key, and a signature
 * made once such a record appeared would fail everywhere. Any lookup error
 * reads as not published.
 */
export async function isEd25519RecordPublished(
	domain: string,
	selector: string,
	expectedDnsRecord: string,
	resolveTxtFn: TxtResolver = resolveTxt
): Promise<boolean> {
	const expected = parseDkimKeyRecord(expectedDnsRecord);
	if (isKeyRecordError(expected)) return false;
	const published = await resolveDkimKey((name) => resolveTxtFn(name), selector, domain, {
		keyType: 'ed25519',
		hash: 'sha256',
	});
	return published.ok && published.record.publicKey === expected.publicKey;
}

/**
 * How long a failed publication check is trusted before DNS is asked again, as
 * for the RSA key: without it every message of a campaign would query the
 * selector while the record is missing.
 */
const UNPUBLISHED_RECHECK_MS = 60_000;
const unpublishedUntil = new Map<string, number>();
const publicationProbes = new Map<string, Promise<void>>();

/** Forget cached publication verdicts (tests). */
export function clearEd25519PublicationCache(): void {
	unpublishedUntil.clear();
	publicationProbes.clear();
}

/** Resolves once every publication probe started so far has finished (tests). */
export async function ed25519PublicationProbesSettled(): Promise<void> {
	await Promise.all(publicationProbes.values());
}

/**
 * Ask DNS, off the send path, whether the key's record is published, and clear
 * the awaiting mark when it is. The message that starts a probe never waits for
 * it: an optional signature must not make a send depend on a resolver or on
 * the Redis write that follows. One probe per key at a time, and none while a
 * failed one is still trusted.
 */
function probePublication(
	redis: Redis,
	domain: string,
	selector: string,
	dnsRecord: string,
	resolveTxtFn: TxtResolver | undefined
): void {
	const cacheKey = `${domain}|${selector}`;
	if (publicationProbes.has(cacheKey)) return;
	if ((unpublishedUntil.get(cacheKey) ?? 0) > Date.now()) return;
	const probe = (async () => {
		try {
			if (await isEd25519RecordPublished(domain, selector, dnsRecord, resolveTxtFn)) {
				await markEd25519KeyPublished(redis, domain, selector);
				unpublishedUntil.delete(cacheKey);
			} else {
				unpublishedUntil.set(cacheKey, Date.now() + UNPUBLISHED_RECHECK_MS);
			}
		} catch (err) {
			unpublishedUntil.set(cacheKey, Date.now() + UNPUBLISHED_RECHECK_MS);
			logger.warn({ err, domain, selector }, 'DKIM Ed25519 publication check failed');
		} finally {
			publicationProbes.delete(cacheKey);
		}
	})();
	publicationProbes.set(cacheKey, probe);
}

/**
 * Why a domain's Ed25519 key added no signature to a message. Bounded: it
 * labels `mta_dkim_ed25519_signatures_total`. None of these is a
 * `DkimUnavailableCause` (`./dkim.ts`); the message goes out with its RSA
 * signature.
 */
export type OptionalDkimSkip = 'org_mismatch' | 'unreadable' | 'unusable' | 'unpublished';

export type OptionalDkimKey =
	| { kind: 'key'; key: DkimSigningKey }
	| { kind: 'none' }
	| { kind: 'skipped'; reason: OptionalDkimSkip };

/**
 * Resolve the domain's Ed25519 key for a second signature. Best effort and
 * never throws: every problem answers `skipped` (or `none` when the domain has
 * no such key), and the caller sends with the RSA signature alone. A key is
 * used only once its record was seen in DNS. While it is awaiting that, each
 * message answers `unpublished` at once and at most starts a background check
 * (`probePublication`); the messages after a successful check carry the
 * signature.
 */
export async function resolveOptionalEd25519Key(
	redis: Redis,
	domain: string,
	organizationId: string | undefined,
	resolveTxtFn?: TxtResolver
): Promise<OptionalDkimKey> {
	const name = domain.toLowerCase();
	try {
		const key = await getDkimConfig(redis, name);
		const ed = key?.ed25519;
		if (!key || !ed) return { kind: 'none' };
		if (isForeignTenantKey(key, organizationId)) return { kind: 'skipped', reason: 'org_mismatch' };
		let privateKey: string;
		try {
			privateKey = getMtaSecretBox().open(ed.sealedPrivateKey);
		} catch {
			return { kind: 'skipped', reason: 'unreadable' };
		}
		let dnsRecord: string;
		try {
			dnsRecord = ed25519DnsRecordFromPrivateKey(privateKey);
		} catch {
			return { kind: 'skipped', reason: 'unusable' };
		}
		if (ed.awaitingDnsSince !== undefined) {
			probePublication(redis, name, ed.selector, dnsRecord, resolveTxtFn);
			return { kind: 'skipped', reason: 'unpublished' };
		}
		return {
			kind: 'key',
			key: {
				domainName: name,
				keySelector: ed.selector,
				privateKey,
				algorithm: 'ed25519-sha256',
			},
		};
	} catch (err) {
		logger.warn({ err, domain: name }, 'DKIM Ed25519 key lookup failed; signing with RSA only');
		return { kind: 'skipped', reason: 'unreadable' };
	}
}
