import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis-mock';
import { createTestConfig } from '../../__tests__/helpers/fixtures.js';
import { queueConvexWebhook } from '../convexNotifier.js';
import {
	claimOne,
	getEntry,
	settleClaim,
	WEBHOOK_DLQ_AUTO_RETRY_LIMIT,
	WEBHOOK_DLQ_CLAIM_LEASE_MS,
	WEBHOOK_DLQ_ENTRIES_KEY,
	WEBHOOK_DLQ_PROTECTED_KEY,
} from '../dlq.js';

describe('terminal webhook outbox', () => {
	let redis: InstanceType<typeof Redis>;
	let originalFetch: typeof globalThis.fetch;

	beforeEach(async () => {
		redis = new Redis();
		await redis.flushall();
		originalFetch = globalThis.fetch;
	});

	afterEach(async () => {
		globalThis.fetch = originalFetch;
		await redis.quit();
	});

	it('persists and protects the row before immediate network delivery begins', async () => {
		let protectedBeforeFetch = false;
		globalThis.fetch = vi.fn(async () => {
			protectedBeforeFetch = (await redis.scard(WEBHOOK_DLQ_PROTECTED_KEY)) === 1;
			return new Response(null, { status: 200 });
		}) as typeof fetch;
		const event = {
			event: 'bounced' as const,
			messageId: 'terminal-crash-replay',
			organizationId: 'org-1',
			bounceType: 'hard' as const,
			timestamp: Date.now(),
		};

		const id = await queueConvexWebhook(
			event,
			createTestConfig(),
			redis,
			'dispatch:terminal-crash-replay:bounced'
		);
		expect(protectedBeforeFetch).toBe(true);
		expect(globalThis.fetch).toHaveBeenCalledOnce();
		await vi.waitFor(async () => expect(await getEntry(redis, id)).toBeNull());
		expect(await redis.scard(WEBHOOK_DLQ_PROTECTED_KEY)).toBe(0);
	});

	it('recovers an abandoned immediate attempt after its durable lease expires', async () => {
		globalThis.fetch = vi.fn(() => new Promise<Response>(() => {})) as typeof fetch;
		const id = await queueConvexWebhook(
			{
				event: 'bounced',
				messageId: 'terminal-abandoned',
				organizationId: 'org-1',
				bounceType: 'hard',
				timestamp: Date.now(),
			},
			createTestConfig(),
			redis,
			'dispatch:terminal-abandoned:bounced'
		);
		expect(await getEntry(redis, id)).not.toBeNull();
		expect(await redis.hget(WEBHOOK_DLQ_ENTRIES_KEY, `claim:${id}`)).toContain('immediate:');

		// Simulate a replacement process after the original owner's lease expired.
		const recoveryAt = Date.now() + WEBHOOK_DLQ_CLAIM_LEASE_MS + 1;
		const recovered = await claimOne(redis, id, {
			owner: 'replacement-process',
			now: recoveryAt,
			requireDue: false,
			enforceAutoLimit: false,
			autoRetryLimit: WEBHOOK_DLQ_AUTO_RETRY_LIMIT,
		});
		expect(recovered).not.toBeNull();
		expect(await settleClaim(redis, recovered!, 'success', recoveryAt + 1)).toBe(true);

		// The replacement settles exactly once; the abandoned owner is fenced by
		// its expired token and cannot resurrect the removed row.
		expect(await getEntry(redis, id)).toBeNull();
		expect(await settleClaim(redis, recovered!, 'success', recoveryAt + 2)).toBe(false);
	});
});
