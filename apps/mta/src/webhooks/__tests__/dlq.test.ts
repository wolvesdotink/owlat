import { describe, it, expect, vi, beforeEach } from 'vitest';
import Redis from 'ioredis-mock';
import {
	classifyWebhookHttpFailure,
	storeFailed,
	listFailed,
	getEntry,
	removeOne,
	updateEntry,
	getStats,
	getAllIds,
	claimEligible,
	claimOne,
	settleClaim,
} from '../dlq.js';
import { createTestConfig } from '../../__tests__/helpers/fixtures.js';
import type { MtaWebhookEvent } from '../../types.js';

const TRANSPORT_FAILURE = { category: 'transport' } as const;

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function createTestEvent(overrides?: Partial<MtaWebhookEvent>): MtaWebhookEvent {
	return {
		event: 'bounced',
		messageId: 'msg-001',
		organizationId: 'org-1',
		bounceType: 'hard',
		message: 'Mailbox not found',
		timestamp: Date.now(),
		...overrides,
	};
}

describe('dlq', () => {
	let redis: InstanceType<typeof Redis>;
	const config = createTestConfig();

	beforeEach(async () => {
		redis = new Redis();
		await redis.flushall();
	});

	describe('storeFailed', () => {
		it('creates entry and returns dlqId', async () => {
			const dlqId = await storeFailed(redis, createTestEvent(), TRANSPORT_FAILURE, config);
			expect(dlqId).toBeTruthy();
			expect(typeof dlqId).toBe('string');
		});
	});

	describe('getEntry', () => {
		it('retrieves entry by dlqId', async () => {
			const failure = classifyWebhookHttpFailure(503);
			const dlqId = await storeFailed(redis, createTestEvent(), failure, config);

			const entry = await getEntry(redis, dlqId);
			expect(entry).not.toBeNull();
			expect(entry!.dlqId).toBe(dlqId);
			expect(entry!.failure).toEqual({ category: 'http', status: 503 });
			expect(entry!.event.event).toBe('bounced');
		});

		it('normalizes legacy free-form errors without returning their text', async () => {
			const legacyErrorSentinel = 'provider-response-must-not-escape';
			const dlqId = 'legacy-entry';
			await redis.set(
				`mta:dlq:entry:${dlqId}`,
				JSON.stringify({
					dlqId,
					event: createTestEvent(),
					error: legacyErrorSentinel,
					attempts: 1,
					createdAt: Date.now(),
				})
			);

			const entry = await getEntry(redis, dlqId);

			expect(entry?.failure).toEqual({ category: 'legacy' });
			expect(JSON.stringify(entry)).not.toContain(legacyErrorSentinel);
			expect(entry).not.toHaveProperty('error');
		});

		it('returns null for non-existent dlqId', async () => {
			const entry = await getEntry(redis, 'non-existent-id');
			expect(entry).toBeNull();
		});
	});

	describe('listFailed', () => {
		it('returns entries newest-first', async () => {
			await storeFailed(redis, createTestEvent({ messageId: 'msg-1' }), TRANSPORT_FAILURE, config);
			await storeFailed(redis, createTestEvent({ messageId: 'msg-2' }), TRANSPORT_FAILURE, config);
			await storeFailed(redis, createTestEvent({ messageId: 'msg-3' }), TRANSPORT_FAILURE, config);

			const result = await listFailed(redis);
			expect(result.entries.length).toBe(3);
			expect(result.total).toBe(3);
			// Newest first: createdAt of first entry >= createdAt of last
			expect(result.entries[0]!.createdAt).toBeGreaterThanOrEqual(result.entries[2]!.createdAt);
		});
	});

	describe('removeOne', () => {
		it('deletes entry and returns true', async () => {
			const dlqId = await storeFailed(redis, createTestEvent(), TRANSPORT_FAILURE, config);

			const removed = await removeOne(redis, dlqId);
			expect(removed).toBe(true);

			const entry = await getEntry(redis, dlqId);
			expect(entry).toBeNull();
		});

		it('returns false for non-existent entry', async () => {
			const removed = await removeOne(redis, 'does-not-exist');
			expect(removed).toBe(false);
		});
	});

	describe('updateEntry', () => {
		it('overwrites entry', async () => {
			const dlqId = await storeFailed(redis, createTestEvent(), TRANSPORT_FAILURE, config);
			const entry = await getEntry(redis, dlqId);

			entry!.attempts = 3;
			entry!.lastRetryAt = Date.now();
			await updateEntry(redis, entry!);

			const updated = await getEntry(redis, dlqId);
			expect(updated!.attempts).toBe(3);
			expect(updated!.lastRetryAt).toBeDefined();
		});
	});

	describe('getStats', () => {
		it('returns total and timestamps', async () => {
			await storeFailed(redis, createTestEvent(), TRANSPORT_FAILURE, config);
			await storeFailed(redis, createTestEvent(), TRANSPORT_FAILURE, config);

			const stats = await getStats(redis);
			expect(stats.total).toBe(2);
			expect(stats.oldestTimestamp).not.toBeNull();
			expect(stats.newestTimestamp).not.toBeNull();
			expect(stats.newestTimestamp!).toBeGreaterThanOrEqual(stats.oldestTimestamp!);
		});

		it('returns nulls when empty', async () => {
			const stats = await getStats(redis);
			expect(stats.total).toBe(0);
			expect(stats.oldestTimestamp).toBeNull();
			expect(stats.newestTimestamp).toBeNull();
		});
	});

	describe('getAllIds', () => {
		it('returns all IDs', async () => {
			const id1 = await storeFailed(redis, createTestEvent(), TRANSPORT_FAILURE, config);
			const id2 = await storeFailed(redis, createTestEvent(), TRANSPORT_FAILURE, config);

			const ids = await getAllIds(redis);
			expect(ids).toContain(id1);
			expect(ids).toContain(id2);
		});
	});

	describe('atomic retry claims', () => {
		async function seedRaw(id: string, attempts: number, createdAt: number) {
			await redis.set(
				`mta:dlq:entry:${id}`,
				JSON.stringify({
					dlqId: id,
					event: createTestEvent({ messageId: id }),
					failure: TRANSPORT_FAILURE,
					attempts,
					createdAt,
				})
			);
			await redis.zadd('mta:dlq', createdAt, id);
		}

		it('walks past more than 50 exhausted entries to claim newer due work', async () => {
			for (let index = 0; index < 51; index++) await seedRaw(`exhausted-${index}`, 8, index);
			await seedRaw('routing-reentry-due', 0, 100);

			const claimed = await claimEligible(redis, {
				owner: 'sweeper-a',
				now: 1_000_000,
				limit: 50,
				autoRetryLimit: 8,
				pageSize: 50,
			});

			expect(claimed.map((entry) => entry.dlqId)).toEqual(['routing-reentry-due']);
			expect(
				(await listFailed(redis, 100)).entries.filter((entry) => entry.attempts === 8)
			).toHaveLength(51);
		});

		it('allows only one owner, reclaims an expired lease, and rejects stale settlement', async () => {
			await seedRaw('race', 0, 0);
			const evalSpy = vi.spyOn(redis, 'eval');
			const options = {
				now: 100_000,
				leaseMs: 1,
				requireDue: true,
				enforceAutoLimit: true,
				autoRetryLimit: 8,
			};
			const [first, second] = await Promise.all([
				claimOne(redis, 'race', { ...options, owner: 'sweeper-a' }),
				claimOne(redis, 'race', { ...options, owner: 'sweeper-b' }),
			]);
			const winner = first ?? second;
			expect([first, second].filter(Boolean)).toHaveLength(1);
			expect(winner).not.toBeNull();
			await new Promise((resolve) => setTimeout(resolve, 5));

			const replacement = await claimOne(redis, 'race', {
				...options,
				owner: 'manual',
				now: 100_002,
				leaseMs: 1_000,
				requireDue: false,
				enforceAutoLimit: false,
			});
			expect(replacement!.claim.version).toBeGreaterThan(winner!.claim.version);
			expect(await settleClaim(redis, winner!, 'failure', 100_003)).toBe(false);
			expect(await settleClaim(redis, replacement!, 'success', 100_003)).toBe(true);
			expect(await getEntry(redis, 'race')).toBeNull();
			// Every ownership CAS script is deliberately single-key; index cleanup
			// is idempotent after the CAS, so Redis Cluster cannot CROSSSLOT.
			expect(evalSpy.mock.calls.every((call) => call[1] === 1)).toBe(true);
		});

		it('prevents a manual retry from racing an active automatic claim', async () => {
			await seedRaw('manual-race', 0, 0);
			const automatic = await claimOne(redis, 'manual-race', {
				owner: 'sweeper',
				now: 100_000,
				requireDue: true,
				enforceAutoLimit: true,
				autoRetryLimit: 8,
			});
			const manual = await claimOne(redis, 'manual-race', {
				owner: 'manual',
				now: 100_001,
				requireDue: false,
				enforceAutoLimit: false,
				autoRetryLimit: 8,
			});
			expect(automatic).not.toBeNull();
			expect(manual).toBeNull();
		});
	});
});
