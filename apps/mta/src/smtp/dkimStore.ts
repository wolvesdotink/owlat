/**
 * DKIM Key Store
 *
 * Redis-backed DKIM key storage with in-memory caching.
 * Keys are cached for 5 minutes to avoid Redis lookups on every send.
 */

import { generateKeyPairSync, createPublicKey } from 'crypto';
import type Redis from 'ioredis';
import type { DkimKeyConfig } from '../types.js';
import { logger } from '../monitoring/logger.js';
import { getMtaSecretBox } from '../lib/secretBox.js';

const DKIM_PREFIX = 'mta:dkim:';
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Hash field on `mta:dkim:{domain}` holding that domain's per-domain VERP
 * return-path host (D1). Co-located with the DKIM material so it shares the
 * domain's lifecycle: registration writes it, `removeDkimKey` (whole-hash DEL)
 * clears it. Absent field → the domain has no override and the sender falls back
 * to the global `RETURN_PATH_DOMAIN` (backward-compatible with every legacy
 * registration written before this field existed).
 */
const RETURN_PATH_FIELD = 'returnPathHost';

/**
 * Unseal a stored DKIM private-key value, migrating a legacy plaintext value in
 * place. Private keys are sealed at rest (secretBox) so a Redis dump never
 * exposes a PEM. Pre-sealing installs — and keys written by an older MTA — hold
 * the raw PEM; on the FIRST read we detect that, re-seal it under
 * `${DKIM_PREFIX}${domain}`, log once, and return the plaintext. The signer
 * therefore always receives the identical PEM, so signatures verify unchanged
 * before and after the migration.
 */
async function unsealPrivateKey(redis: Redis, domain: string, stored: string): Promise<string> {
	const box = getMtaSecretBox();
	if (box.isSealed(stored)) {
		return box.open(stored);
	}
	// Legacy plaintext PEM — seal it in place (lazy boot migration), then use it.
	// Guard the write against a concurrent setDkimKey (e.g. rotation activation)
	// that landed a NEW sealed key between our earlier hgetall and now: re-read the
	// field and only replace it if it is STILL the exact plaintext we read. Without
	// this compare, the re-seal of the stale key would clobber the new key while
	// the selector kept the new value → selector/key mismatch → DKIM failures.
	const current = await redis.hget(`${DKIM_PREFIX}${domain}`, 'privateKey');
	if (current === stored) {
		await redis.hset(`${DKIM_PREFIX}${domain}`, { privateKey: box.seal(stored) });
		logger.info({ domain }, 'DKIM private key sealed in place (plaintext → sealed migration)');
	}
	return stored;
}

interface CachedKey {
	config: DkimKeyConfig;
	cachedAt: number;
}

// In-memory cache
const cache = new Map<string, CachedKey>();

interface CachedReturnPathHost {
	host: string | null;
	cachedAt: number;
}

// Separate small cache for the per-domain return-path host so the hot send path
// (one lookup per outbound message) does not hit Redis every time. Negative
// results (`null` — no override) are cached too, so the common "no per-domain
// host" case is a single cache hit rather than a Redis round-trip per send.
const returnPathCache = new Map<string, CachedReturnPathHost>();

/**
 * Get DKIM config for a domain (cache-first, then Redis)
 */
export async function getDkimConfig(redis: Redis, domain: string): Promise<DkimKeyConfig | null> {
	// Check cache
	const cached = cache.get(domain);
	if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
		return cached.config;
	}

	// Check Redis
	const data = await redis.hgetall(`${DKIM_PREFIX}${domain}`);
	if (!data || !data['selector'] || !data['privateKey']) return null;

	const config: DkimKeyConfig = {
		selector: data['selector'],
		privateKey: await unsealPrivateKey(redis, domain, data['privateKey']),
	};

	// Update cache
	cache.set(domain, { config, cachedAt: Date.now() });
	return config;
}

/**
 * Store a DKIM key for a domain
 */
export async function setDkimKey(
	redis: Redis,
	domain: string,
	selector: string,
	privateKey: string
): Promise<void> {
	// Seal the private key at rest so a Redis dump never exposes a PEM. The
	// selector and timestamps stay plaintext (non-secret). getDkimConfig unseals
	// transparently on read, so callers still see the raw PEM.
	await redis.hset(`${DKIM_PREFIX}${domain}`, {
		selector,
		privateKey: getMtaSecretBox().seal(privateKey),
		addedAt: String(Date.now()),
		rotatedAt: String(Date.now()),
	});

	// Invalidate cache
	cache.delete(domain);
	logger.info({ domain, selector }, 'DKIM key stored');
}

/**
 * Remove a DKIM key for a domain
 */
export async function removeDkimKey(redis: Redis, domain: string): Promise<boolean> {
	const result = await redis.del(`${DKIM_PREFIX}${domain}`);
	cache.delete(domain);
	returnPathCache.delete(domain);
	return result > 0;
}

/**
 * Store a domain's per-domain VERP return-path host (D1).
 *
 * The value MUST already be a validated, normalized DNS FQDN (see
 * `lib/returnPathHost.normalizeReturnPathHost`) — this function does no
 * validation of its own. Persisted as a plaintext field on the domain's
 * `mta:dkim:{domain}` hash, so it survives alongside the DKIM key and is dropped
 * when the domain is removed.
 */
export async function setReturnPathHost(
	redis: Redis,
	domain: string,
	returnPathHost: string
): Promise<void> {
	await redis.hset(`${DKIM_PREFIX}${domain}`, { [RETURN_PATH_FIELD]: returnPathHost });
	returnPathCache.delete(domain);
	logger.info({ domain, returnPathHost }, 'Per-domain return-path host stored');
}

/**
 * Get a domain's per-domain VERP return-path host, or `null` when the domain has
 * no override (legacy registration, or one made without the field). The sender
 * uses `null` as the signal to fall back to the global `RETURN_PATH_DOMAIN`.
 *
 * Cache-first (including negative results) so the outbound hot path costs at
 * most one Redis `HGET` per cache-TTL window per domain.
 */
export async function getReturnPathHost(redis: Redis, domain: string): Promise<string | null> {
	const cached = returnPathCache.get(domain);
	if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
		return cached.host;
	}

	const stored = await redis.hget(`${DKIM_PREFIX}${domain}`, RETURN_PATH_FIELD);
	const host = stored && stored.length > 0 ? stored : null;
	returnPathCache.set(domain, { host, cachedAt: Date.now() });
	return host;
}

/**
 * Whether a DKIM key currently exists for a domain (Redis, not cache).
 */
export async function hasDkimKey(redis: Redis, domain: string): Promise<boolean> {
	return (await redis.exists(`${DKIM_PREFIX}${domain}`)) > 0;
}

/**
 * List all DKIM domains (keys redacted)
 */
export async function listDkimDomains(redis: Redis): Promise<
	Array<{
		domain: string;
		selector: string;
		addedAt?: number;
		rotatedAt?: number;
	}>
> {
	const results: Array<{ domain: string; selector: string; addedAt?: number; rotatedAt?: number }> =
		[];
	let cursor = '0';

	do {
		const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', `${DKIM_PREFIX}*`, 'COUNT', 100);
		cursor = nextCursor;

		for (const key of keys) {
			const data = await redis.hgetall(key);
			if (data['selector']) {
				results.push({
					domain: key.replace(DKIM_PREFIX, ''),
					selector: data['selector'],
					addedAt: data['addedAt'] ? parseInt(data['addedAt'], 10) : undefined,
					rotatedAt: data['rotatedAt'] ? parseInt(data['rotatedAt'], 10) : undefined,
				});
			}
		}
	} while (cursor !== '0');

	return results;
}

/**
 * Generate a new RSA 2048-bit key pair and store it
 * Returns the public key formatted as a DNS TXT record value
 */
export async function rotateKey(
	redis: Redis,
	domain: string,
	selector?: string
): Promise<{ selector: string; dnsRecord: string }> {
	const newSelector = selector ?? `s${Date.now()}`;

	const { publicKey, privateKey } = generateKeyPairSync('rsa', {
		modulusLength: 2048,
		publicKeyEncoding: { type: 'spki', format: 'pem' },
		privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
	});

	await setDkimKey(redis, domain, newSelector, privateKey);

	// Format public key for DNS TXT record
	const pubKeyBase64 = publicKey
		.replace('-----BEGIN PUBLIC KEY-----', '')
		.replace('-----END PUBLIC KEY-----', '')
		.replace(/\s/g, '');

	const dnsRecord = `v=DKIM1; k=rsa; p=${pubKeyBase64}`;

	logger.info({ domain, selector: newSelector }, 'DKIM key rotated');
	return { selector: newSelector, dnsRecord };
}

/**
 * Register a domain's DKIM key for the in-app "Add domain" flow.
 *
 * This is the FIRST-TIME generation path. It MUST NOT clobber an existing key
 * (e.g. one pre-seeded from the `DKIM_KEYS` env var), because overwriting it
 * would change the selector and private key out from under the published DNS
 * TXT record and break signing. If a key already exists it is returned as-is
 * (no new generation); the caller surfaces the existing selector + DNS record.
 *
 * Use {@link rotateKey} (not this) for deliberate key rotation, which replaces
 * the active key on purpose.
 */
export async function registerDomainKey(
	redis: Redis,
	domain: string
): Promise<{ selector: string; dnsRecord: string; created: boolean }> {
	const existing = await getDkimConfig(redis, domain);
	if (existing) {
		logger.info(
			{ domain, selector: existing.selector },
			'DKIM key already exists — registration is a no-op (not clobbering)'
		);
		return {
			selector: existing.selector,
			dnsRecord: dnsRecordFromPrivateKey(existing.privateKey),
			created: false,
		};
	}

	const { selector, dnsRecord } = await rotateKey(redis, domain);
	return { selector, dnsRecord, created: true };
}

/**
 * Derive the public DNS TXT record value from a stored private key.
 * Used when surfacing an already-registered domain's DKIM record.
 */
function dnsRecordFromPrivateKey(privateKeyPem: string): string {
	const publicKey = createPublicKey(privateKeyPem).export({
		type: 'spki',
		format: 'pem',
	}) as string;

	const pubKeyBase64 = publicKey
		.replace('-----BEGIN PUBLIC KEY-----', '')
		.replace('-----END PUBLIC KEY-----', '')
		.replace(/\s/g, '');

	return `v=DKIM1; k=rsa; p=${pubKeyBase64}`;
}

/**
 * Seed Redis from env var config (called on startup)
 * Only adds keys that don't already exist in Redis
 */
export async function seedFromConfig(
	redis: Redis,
	envKeys: Record<string, DkimKeyConfig>
): Promise<void> {
	for (const [domain, config] of Object.entries(envKeys)) {
		const existing = await redis.exists(`${DKIM_PREFIX}${domain}`);
		if (!existing) {
			await setDkimKey(redis, domain, config.selector, config.privateKey);
			logger.info({ domain, selector: config.selector }, 'DKIM key seeded from env');
		}
	}
}

/**
 * Clear the in-memory cache (for testing)
 */
export function clearCache(): void {
	cache.clear();
	returnPathCache.clear();
}
