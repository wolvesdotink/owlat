import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type RealRedis from 'ioredis';
import {
	initiateRotation,
	activatePendingKey,
	cancelRotation,
	getRotationState,
	checkRotationStatus,
	isPendingDnsPublished,
} from '../dkimRotation.js';
import { setDkimKey, getDkimConfig, clearCache } from '../dkimStore.js';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('dkimRotation', () => {
	let redis: RealRedis;

	beforeEach(async () => {
		redis = new Redis() as unknown as RealRedis;
		clearCache();
		// Set up a domain with an existing DKIM key
		await setDkimKey(redis, 'example.com', 's1', '-----BEGIN PRIVATE KEY-----\nfake-key\n-----END PRIVATE KEY-----');
	});

	afterEach(async () => {
		await redis.flushall();
		clearCache();
	});

	describe('initiateRotation', () => {
		it('generates a new key pair and stores pending state', async () => {
			const result = await initiateRotation(redis, 'example.com', {
				selector: 's2',
				overlapHours: 24,
			});

			expect(result.selector).toBe('s2');
			expect(result.dnsRecord).toMatch(/^v=DKIM1; k=rsa; p=/);
			expect(result.activateAfter).toBeInstanceOf(Date);

			// Active key should still be the old one
			const config = await getDkimConfig(redis, 'example.com');
			expect(config?.selector).toBe('s1');

			// Rotation state should reflect pending
			const state = await getRotationState(redis, 'example.com');
			expect(state?.activeSelector).toBe('s1');
			expect(state?.pendingSelector).toBe('s2');
			expect(state?.pendingDnsRecord).toMatch(/^v=DKIM1; k=rsa; p=/);
		});

		it('rejects if already has pending rotation', async () => {
			await initiateRotation(redis, 'example.com', { selector: 's2' });

			await expect(
				initiateRotation(redis, 'example.com', { selector: 's3' })
			).rejects.toThrow('already has a pending rotation');
		});

		it('rejects if no DKIM key exists', async () => {
			await expect(
				initiateRotation(redis, 'nonexistent.com', { selector: 's1' })
			).rejects.toThrow('No DKIM key configured');
		});

		// PR-27 — Regression-lock the rotated key strength. RFC 8301 mandates
		// >=1024-bit and current ESP policy expects 2048-bit RSA; a default
		// keySize regression would silently weaken every rotated key. Initiate +
		// force-activate, then assert the now-active private key is 2048-bit.
		it('produces a 2048-bit RSA private key by default (RFC 8301)', async () => {
			const { createPrivateKey } = await import('crypto');
			await initiateRotation(redis, 'example.com', { selector: 's2', overlapHours: 0 });
			const activated = await activatePendingKey(redis, 'example.com', true);
			expect(activated.activated).toBe(true);

			clearCache();
			const config = await getDkimConfig(redis, 'example.com');
			const details = createPrivateKey(config!.privateKey).asymmetricKeyDetails;
			expect(details?.modulusLength).toBe(2048);
		});
	});

	describe('activatePendingKey', () => {
		it('refuses activation before overlap period', async () => {
			await initiateRotation(redis, 'example.com', {
				selector: 's2',
				overlapHours: 48,
			});

			const result = await activatePendingKey(redis, 'example.com');
			expect(result.activated).toBe(false);
		});

		it('activates with force=true ignoring overlap', async () => {
			await initiateRotation(redis, 'example.com', {
				selector: 's2',
				overlapHours: 48,
			});

			const result = await activatePendingKey(redis, 'example.com', true);
			expect(result.activated).toBe(true);
			expect(result.selector).toBe('s2');

			// Active key should now be the new one
			clearCache();
			const config = await getDkimConfig(redis, 'example.com');
			expect(config?.selector).toBe('s2');
		});

		it('returns false if no pending rotation', async () => {
			const result = await activatePendingKey(redis, 'example.com');
			expect(result.activated).toBe(false);
		});

		it('refuses activation while the new DNS record is unpublished (overlap elapsed)', async () => {
			await initiateRotation(redis, 'example.com', { selector: 's2', overlapHours: 0 });
			const notPublished = vi.fn(async (): Promise<string[][]> => []);
			const result = await activatePendingKey(redis, 'example.com', false, notPublished);
			expect(result.activated).toBe(false);
			expect(notPublished).toHaveBeenCalledWith('s2._domainkey.example.com');
		});

		it('activates once the new DNS record is published', async () => {
			const { dnsRecord } = await initiateRotation(redis, 'example.com', { selector: 's2', overlapHours: 0 });
			const published = vi.fn(async (): Promise<string[][]> => [[dnsRecord]]);
			const result = await activatePendingKey(redis, 'example.com', false, published);
			expect(result.activated).toBe(true);
			expect(result.selector).toBe('s2');
		});
	});

	describe('isPendingDnsPublished', () => {
		const RECORD = 'v=DKIM1; k=rsa; p=ABC123key+/=';

		it('is true when the published TXT carries the expected key (chunked + whitespace tolerant)', async () => {
			const resolver = async (): Promise<string[][]> => [['v=DKIM1; k=rsa; ', 'p=ABC123key+/=']];
			expect(await isPendingDnsPublished('example.com', 's2', RECORD, resolver)).toBe(true);
		});

		it('is false when the record is absent, wrong, or the lookup fails', async () => {
			expect(await isPendingDnsPublished('example.com', 's2', RECORD, async () => [])).toBe(false);
			expect(await isPendingDnsPublished('example.com', 's2', RECORD, async () => [['p=OTHERKEY']])).toBe(false);
			expect(await isPendingDnsPublished('example.com', 's2', RECORD, async () => { throw new Error('NXDOMAIN'); })).toBe(false);
			expect(await isPendingDnsPublished('example.com', 's2', undefined, async () => [[RECORD]])).toBe(false);
		});
	});

	describe('Convex propagation (RFC 6376 §3.6.1)', () => {
		it('initiateRotation notifies Convex with the pending selector + record', async () => {
			const notify = vi.fn(async () => {});
			const result = await initiateRotation(redis, 'example.com', {
				selector: 's2',
				overlapHours: 24,
				notify,
			});

			expect(notify).toHaveBeenCalledTimes(1);
			expect(notify).toHaveBeenCalledWith({
				domain: 'example.com',
				selector: 's2',
				dnsRecord: result.dnsRecord,
				phase: 'pending',
			});
		});

		it('activatePendingKey notifies Convex with the activated selector', async () => {
			const notify = vi.fn(async () => {});
			const { dnsRecord } = await initiateRotation(redis, 'example.com', {
				selector: 's2',
				overlapHours: 0,
			});

			const published = vi.fn(async (): Promise<string[][]> => [[dnsRecord]]);
			const result = await activatePendingKey(redis, 'example.com', false, published, notify);

			expect(result.activated).toBe(true);
			expect(notify).toHaveBeenCalledTimes(1);
			expect(notify).toHaveBeenCalledWith({
				domain: 'example.com',
				selector: 's2',
				dnsRecord,
				phase: 'activated',
			});
		});

		it('does not notify Convex when activation is refused', async () => {
			const notify = vi.fn(async () => {});
			await initiateRotation(redis, 'example.com', { selector: 's2', overlapHours: 48 });

			const result = await activatePendingKey(redis, 'example.com', false, undefined, notify);

			expect(result.activated).toBe(false);
			expect(notify).not.toHaveBeenCalled();
		});
	});

	describe('cancelRotation', () => {
		it('cancels a pending rotation', async () => {
			await initiateRotation(redis, 'example.com', { selector: 's2' });
			const cancelled = await cancelRotation(redis, 'example.com');
			expect(cancelled).toBe(true);

			const state = await getRotationState(redis, 'example.com');
			expect(state?.pendingSelector).toBeUndefined();
		});

		it('returns false if no pending rotation', async () => {
			const cancelled = await cancelRotation(redis, 'example.com');
			expect(cancelled).toBe(false);
		});
	});

	describe('checkRotationStatus', () => {
		it('detects pending keys ready for activation', async () => {
			await initiateRotation(redis, 'example.com', {
				selector: 's2',
				overlapHours: 0, // immediate activation
			});

			const status = await checkRotationStatus(redis);
			const entry = status.find(s => s.domain === 'example.com');
			expect(entry?.action).toBe('pending_ready');
		});
	});
});
