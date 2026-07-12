import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSign, generateKeyPairSync } from 'crypto';
import Redis from 'ioredis-mock';
import {
	getDkimConfig,
	setDkimKey,
	removeDkimKey,
	rotateKey,
	registerDomainKey,
	hasDkimKey,
	seedFromConfig,
	clearCache,
} from '../dkimStore.js';
import { getMtaSecretBox } from '../../lib/secretBox.js';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const DKIM_PREFIX = 'mta:dkim:';

/** Sign a fixed message with a PEM private key — proves the key is usable and unchanged. */
function signWith(privateKeyPem: string): string {
	return createSign('RSA-SHA256').update('dkim-canary').sign(privateKeyPem, 'base64');
}

describe('dkimStore', () => {
	let redis: InstanceType<typeof Redis>;

	beforeEach(() => {
		redis = new Redis();
		clearCache();
	});

	describe('getDkimConfig', () => {
		it('returns null when no key exists', async () => {
			const result = await getDkimConfig(redis, 'unknown.com');
			expect(result).toBeNull();
		});
	});

	describe('setDkimKey + getDkimConfig', () => {
		it('round-trips correctly', async () => {
			await setDkimKey(redis, 'test.com', 's2024', 'private-key-data');

			const config = await getDkimConfig(redis, 'test.com');
			expect(config).not.toBeNull();
			expect(config!.selector).toBe('s2024');
			expect(config!.privateKey).toBe('private-key-data');
		});
	});

	describe('cache behavior', () => {
		it('second call returns cached result', async () => {
			await setDkimKey(redis, 'cached.com', 'sel1', 'pk1');

			// First call populates cache
			await getDkimConfig(redis, 'cached.com');

			// Delete from Redis directly
			await redis.del('mta:dkim:cached.com');

			// Second call should still return from cache
			const config = await getDkimConfig(redis, 'cached.com');
			expect(config).not.toBeNull();
			expect(config!.selector).toBe('sel1');
		});

		it('clearCache invalidates cache', async () => {
			await setDkimKey(redis, 'clearcache.com', 'sel1', 'pk1');
			await getDkimConfig(redis, 'clearcache.com'); // populate cache

			await redis.del('mta:dkim:clearcache.com'); // remove from Redis
			clearCache();

			const config = await getDkimConfig(redis, 'clearcache.com');
			expect(config).toBeNull();
		});
	});

	describe('removeDkimKey', () => {
		it('deletes from Redis', async () => {
			await setDkimKey(redis, 'remove.com', 'sel', 'pk');

			const removed = await removeDkimKey(redis, 'remove.com');
			expect(removed).toBe(true);

			clearCache();
			const config = await getDkimConfig(redis, 'remove.com');
			expect(config).toBeNull();
		});
	});

	describe('rotateKey', () => {
		it('generates new RSA key and returns DNS record format', async () => {
			const result = await rotateKey(redis, 'rotate.com', 'newsel');

			expect(result.selector).toBe('newsel');
			expect(result.dnsRecord).toContain('v=DKIM1; k=rsa; p=');

			clearCache();
			const config = await getDkimConfig(redis, 'rotate.com');
			expect(config).not.toBeNull();
			expect(config!.selector).toBe('newsel');
			expect(config!.privateKey).toContain('BEGIN PRIVATE KEY');
		});

		// PR-27 — Regression-lock the generated key strength. RFC 8301 deprecates
		// keys below 1024 bits; modern ESPs (Gmail/Yahoo) and DKIM best practice
		// require >=2048-bit RSA. A drop to 1024 would silently weaken every
		// rotated key, so pin the modulus length of the actual stored private key.
		it('generates a 2048-bit RSA private key (RFC 8301)', async () => {
			const { createPrivateKey } = await import('crypto');
			await rotateKey(redis, 'strength.com', 'sel2048');

			clearCache();
			const config = await getDkimConfig(redis, 'strength.com');
			const details = createPrivateKey(config!.privateKey).asymmetricKeyDetails;
			expect(details?.modulusLength).toBe(2048);
		});
	});

	describe('rotateKey clobbers an existing key (the bug PR-66 guards against)', () => {
		// Documents the underlying hazard: an unconditional rotate (the old
		// Add-domain path) overwrites a pre-seeded selector/key in Redis,
		// breaking DKIM for the already-published DNS record.
		it('rotateKey with no selector overwrites a pre-seeded s1 key', async () => {
			// Operator followed the old doc: openssl-generate s1, DKIM_KEYS, seed.
			await setDkimKey(redis, 'clobber.com', 's1', 's1-private-key');
			clearCache();

			const before = await getDkimConfig(redis, 'clobber.com');
			expect(before!.selector).toBe('s1');

			// Old Add-domain flow: POST /rotate with no selector → s{timestamp}.
			const rotated = await rotateKey(redis, 'clobber.com');
			expect(rotated.selector).not.toBe('s1');

			clearCache();
			const after = await getDkimConfig(redis, 'clobber.com');
			// The s1 key is GONE — the published s1 DNS record now mismatches.
			expect(after!.selector).toBe(rotated.selector);
			expect(after!.selector).not.toBe('s1');
			expect(after!.privateKey).not.toBe('s1-private-key');
		});
	});

	describe('registerDomainKey only generates when no key exists (the fix)', () => {
		it('generates a new key when the domain has none', async () => {
			expect(await hasDkimKey(redis, 'fresh.com')).toBe(false);

			const result = await registerDomainKey(redis, 'fresh.com');
			expect(result.created).toBe(true);
			expect(result.selector).toMatch(/^s\d+$/);
			expect(result.dnsRecord).toContain('v=DKIM1; k=rsa; p=');

			clearCache();
			const config = await getDkimConfig(redis, 'fresh.com');
			expect(config!.selector).toBe(result.selector);
		});

		it('does NOT clobber a pre-seeded key — returns it as-is', async () => {
			// Pre-seed a real RSA key (as DKIM_KEYS seeding would).
			const { generateKeyPairSync } = await import('crypto');
			const { privateKey } = generateKeyPairSync('rsa', {
				modulusLength: 2048,
				publicKeyEncoding: { type: 'spki', format: 'pem' },
				privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
			});
			await setDkimKey(redis, 'seeded.com', 's1', privateKey);
			clearCache();

			const result = await registerDomainKey(redis, 'seeded.com');

			// No new key generated; the existing s1 key is preserved.
			expect(result.created).toBe(false);
			expect(result.selector).toBe('s1');
			expect(result.dnsRecord).toContain('v=DKIM1; k=rsa; p=');

			clearCache();
			const config = await getDkimConfig(redis, 'seeded.com');
			expect(config!.selector).toBe('s1');
			expect(config!.privateKey).toBe(privateKey);
		});

		it('is idempotent — repeated registration keeps the same key', async () => {
			const first = await registerDomainKey(redis, 'idempotent.com');
			expect(first.created).toBe(true);

			const second = await registerDomainKey(redis, 'idempotent.com');
			expect(second.created).toBe(false);
			expect(second.selector).toBe(first.selector);
		});
	});

	describe('secrets at rest (sealed private keys)', () => {
		it('stores the private key SEALED in Redis but returns plaintext on read', async () => {
			const pem = '-----BEGIN PRIVATE KEY-----\nMIISEALEDkeymaterial\n-----END PRIVATE KEY-----';
			await setDkimKey(redis, 'sealed.com', 's1', pem);

			// The raw Redis value is a sealed token — no PEM markers in a dump.
			const raw = await redis.hget(`${DKIM_PREFIX}sealed.com`, 'privateKey');
			expect(raw).toBeTruthy();
			expect(raw).not.toContain('BEGIN PRIVATE KEY');
			expect(getMtaSecretBox().isSealed(raw!)).toBe(true);

			// But getDkimConfig unseals transparently — caller sees the original PEM.
			clearCache();
			const config = await getDkimConfig(redis, 'sealed.com');
			expect(config!.privateKey).toBe(pem);
		});

		it('migrates a legacy plaintext key in place on first read (byte-identical signing)', async () => {
			// A real RSA key an OLD MTA wrote as plaintext straight into the hash.
			const { privateKey } = generateKeyPairSync('rsa', {
				modulusLength: 2048,
				publicKeyEncoding: { type: 'spki', format: 'pem' },
				privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
			});
			await redis.hset(`${DKIM_PREFIX}legacy.com`, {
				selector: 's1',
				privateKey, // plaintext PEM, bypassing setDkimKey's sealing
			});

			// Signature the signer would produce BEFORE migration (raw seeded key).
			const before = signWith(privateKey);

			// First read: detects plaintext, seals it in place, returns the PEM.
			clearCache();
			const first = await getDkimConfig(redis, 'legacy.com');
			expect(first!.privateKey).toBe(privateKey);
			expect(signWith(first!.privateKey)).toBe(before);

			// Redis now holds a sealed token — the plaintext PEM is gone from at-rest.
			const rawAfter = await redis.hget(`${DKIM_PREFIX}legacy.com`, 'privateKey');
			expect(rawAfter).not.toContain('BEGIN PRIVATE KEY');
			expect(getMtaSecretBox().isSealed(rawAfter!)).toBe(true);

			// Second read (from the sealed value): still the identical PEM + signature.
			clearCache();
			const second = await getDkimConfig(redis, 'legacy.com');
			expect(second!.privateKey).toBe(privateKey);
			expect(signWith(second!.privateKey)).toBe(before);
		});
	});

	describe('seedFromConfig', () => {
		it('only adds non-existing keys', async () => {
			// Pre-existing key
			await setDkimKey(redis, 'existing.com', 'old-sel', 'old-pk');

			await seedFromConfig(redis, {
				'existing.com': { selector: 'new-sel', privateKey: 'new-pk' },
				'new.com': { selector: 'fresh-sel', privateKey: 'fresh-pk' },
			});

			clearCache();

			// existing.com should keep old values
			const existing = await getDkimConfig(redis, 'existing.com');
			expect(existing!.selector).toBe('old-sel');

			// new.com should be added
			const fresh = await getDkimConfig(redis, 'new.com');
			expect(fresh!.selector).toBe('fresh-sel');
		});
	});
});
