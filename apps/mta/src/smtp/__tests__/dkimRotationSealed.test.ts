import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSign } from 'crypto';
import Redis from 'ioredis-mock';
import { setDkimKey, getDkimConfig, clearCache } from '../dkimStore.js';
import { initiateRotation, activatePendingKey } from '../dkimRotation.js';
import { getMtaSecretBox } from '../../lib/secretBox.js';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const DKIM_PREFIX = 'mta:dkim:';

/** Sign a fixed message with a PEM private key — proves the key is usable and unchanged. */
function signWith(privateKeyPem: string): string {
	return createSign('RSA-SHA256').update('dkim-rotation-canary').sign(privateKeyPem, 'base64');
}

/**
 * The pending rotation key lives in `mta:dkim:pending:<domain>` for the whole
 * multi-day DNS-propagation overlap. These tests lock the acceptance criterion
 * "a redis-cli dump contains no PEM markers" for THAT path (the frozen
 * dkimRotation suite only exercises the module API, never the raw pending hash)
 * and prove the promoted key is byte-identical to the one generated.
 */
describe('DKIM rotation — pending key sealed at rest', () => {
	let redis: InstanceType<typeof Redis>;

	beforeEach(async () => {
		redis = new Redis();
		// ioredis-mock shares one data store across `new Redis()` instances, so a
		// pending rotation from a prior test would leak into this one. Flush first.
		await redis.flushall();
		clearCache();
		// A rotation needs an existing active key for the domain.
		await setDkimKey(redis, 'rot.com', 's-active', 'active-private-key');
		clearCache();
	});

	it('seals the pending private key on write — no PEM markers in a Redis dump', async () => {
		await initiateRotation(redis, 'rot.com', { selector: 's-pending' });

		const raw = await redis.hget(`${DKIM_PREFIX}pending:rot.com`, 'privateKey');
		expect(raw).toBeTruthy();
		expect(raw).not.toContain('BEGIN PRIVATE KEY');
		expect(raw).not.toContain('PRIVATE KEY');
		expect(getMtaSecretBox().isSealed(raw!)).toBe(true);
	});

	it('promotes the pending key byte-identically on activation (signing unchanged)', async () => {
		await initiateRotation(redis, 'rot.com', { selector: 's-pending' });

		// Unseal the pending key exactly as activation will, to capture a reference.
		const rawPending = await redis.hget(`${DKIM_PREFIX}pending:rot.com`, 'privateKey');
		const pendingPem = getMtaSecretBox().open(rawPending!);
		const sigBefore = signWith(pendingPem);

		// force=true skips the overlap wait + DNS-published check.
		const result = await activatePendingKey(redis, 'rot.com', true);
		expect(result.activated).toBe(true);
		expect(result.selector).toBe('s-pending');

		// The active key now equals the pending PEM byte-for-byte → identical signature.
		clearCache();
		const active = await getDkimConfig(redis, 'rot.com');
		expect(active!.selector).toBe('s-pending');
		expect(active!.privateKey).toBe(pendingPem);
		expect(signWith(active!.privateKey)).toBe(sigBefore);

		// The active hash is sealed too (dkimStore re-seals), and the pending hash is gone.
		const rawActive = await redis.hget(`${DKIM_PREFIX}rot.com`, 'privateKey');
		expect(rawActive).not.toContain('BEGIN PRIVATE KEY');
		expect(getMtaSecretBox().isSealed(rawActive!)).toBe(true);
		expect(await redis.exists(`${DKIM_PREFIX}pending:rot.com`)).toBe(0);
	});

	it('tolerates a legacy plaintext pending key written by an older MTA', async () => {
		await initiateRotation(redis, 'rot.com', { selector: 's-legacy' });

		// Simulate an older MTA that wrote the pending PEM in the clear: read the
		// sealed value, unseal it, and overwrite the hash with the raw plaintext.
		const rawPending = await redis.hget(`${DKIM_PREFIX}pending:rot.com`, 'privateKey');
		const pendingPem = getMtaSecretBox().open(rawPending!);
		await redis.hset(`${DKIM_PREFIX}pending:rot.com`, { privateKey: pendingPem });
		const sigBefore = signWith(pendingPem);

		const result = await activatePendingKey(redis, 'rot.com', true);
		expect(result.activated).toBe(true);

		clearCache();
		const active = await getDkimConfig(redis, 'rot.com');
		expect(active!.privateKey).toBe(pendingPem);
		expect(signWith(active!.privateKey)).toBe(sigBefore);
	});
});
