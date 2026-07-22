import { describe, it, expect, vi, beforeEach } from 'vitest';
import Redis from 'ioredis-mock';
import {
	classifyWebhookHttpFailure,
	storeFailed,
	listFailed,
	getEntry,
	removeOne,
	getStats,
	getAllIds,
	listEligibleIds,
	claimOne,
	settleClaim,
	webhookDlqRetryDelayMs,
	WEBHOOK_DLQ_ENTRIES_KEY,
	WEBHOOK_DLQ_CREATED_KEY,
	WEBHOOK_DLQ_DUE_KEY,
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
			await redis.hset(
				WEBHOOK_DLQ_ENTRIES_KEY,
				dlqId,
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
		async function seedRaw(
			id: string,
			attempts: number,
			createdAt: number,
			options: { includeExhaustedInDue?: boolean } = {}
		) {
			await redis.hset(
				WEBHOOK_DLQ_ENTRIES_KEY,
				id,
				JSON.stringify({
					dlqId: id,
					event: createTestEvent({ messageId: id }),
					failure: TRANSPORT_FAILURE,
					attempts,
					createdAt,
				})
			);
			await redis.hset(WEBHOOK_DLQ_ENTRIES_KEY, `attempts:${id}`, String(attempts));
			await redis.zadd(WEBHOOK_DLQ_CREATED_KEY, createdAt, id);
			if (attempts < 8 || options.includeExhaustedInDue) {
				await redis.zadd(WEBHOOK_DLQ_DUE_KEY, createdAt + 60_000, id);
			}
		}

		it('drains a legacy >1000 exhausted due prefix without deleting inspectable rows', async () => {
			for (let index = 0; index < 1_001; index++) {
				await seedRaw(`exhausted-${index}`, 8, index, { includeExhaustedInDue: true });
			}
			await seedRaw('routing-reentry-due', 0, 2_000);

			const firstPage = await listEligibleIds(redis, {
				now: 1_000_000,
				limit: 50,
				scanLimit: 1_000,
			});
			expect(firstPage).toHaveLength(1_000);
			expect(firstPage).not.toContain('routing-reentry-due');
			for (const id of firstPage) {
				expect(
					await claimOne(redis, id, {
						owner: 'sweeper-first-pass',
						now: 1_000_000,
						requireDue: true,
						enforceAutoLimit: true,
						autoRetryLimit: 8,
					})
				).toBeNull();
			}

			const secondPage = await listEligibleIds(redis, {
				now: 1_000_000,
				limit: 50,
				scanLimit: 1_000,
			});
			expect(secondPage).toContain('routing-reentry-due');
			expect(
				await claimOne(redis, 'routing-reentry-due', {
					owner: 'sweeper-second-pass',
					now: 1_000_000,
					requireDue: true,
					enforceAutoLimit: true,
					autoRetryLimit: 8,
				})
			).not.toBeNull();
			expect(
				(await listFailed(redis, 2_000)).entries.filter((entry) => entry.attempts === 8)
			).toHaveLength(1_001);
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
			// Every transition covers the same three shared-hash-slot structures.
			expect(evalSpy.mock.calls.every((call) => call[1] === 3)).toBe(true);
		});

		it('bases retry due time on actual settlement completion and clears transient claim fields', async () => {
			await seedRaw('completion-backoff', 0, 0);
			const claimed = await claimOne(redis, 'completion-backoff', {
				owner: 'sweeper',
				now: 100_000,
				leaseMs: 50_000,
				requireDue: true,
				enforceAutoLimit: true,
				autoRetryLimit: 8,
			});
			expect(claimed).not.toBeNull();

			const completedAt = 140_000;
			expect(await settleClaim(redis, claimed!, 'failure', completedAt)).toBe(true);
			expect(Number(await redis.zscore(WEBHOOK_DLQ_DUE_KEY, 'completion-backoff'))).toBe(
				completedAt + webhookDlqRetryDelayMs(1)
			);
			const fields = await redis.hkeys(WEBHOOK_DLQ_ENTRIES_KEY);
			expect(fields).not.toContain('claim:completion-backoff');
			expect(fields).not.toContain('claim-expiry:completion-backoff');
			expect(fields.filter((field) => field.endsWith('completion-backoff')).sort()).toEqual([
				'attempts:completion-backoff',
				'completion-backoff',
				'version:completion-backoff',
			]);
		});

		it('removes payload, attempts, claim, expiry, and version after successful settlement', async () => {
			await seedRaw('metadata-cleanup', 0, 0);
			const claimed = await claimOne(redis, 'metadata-cleanup', {
				owner: 'sweeper',
				now: 100_000,
				requireDue: true,
				enforceAutoLimit: true,
				autoRetryLimit: 8,
			});
			expect(claimed).not.toBeNull();
			expect(await settleClaim(redis, claimed!, 'success', 100_100)).toBe(true);
			expect(
				(await redis.hkeys(WEBHOOK_DLQ_ENTRIES_KEY)).filter((field) =>
					field.endsWith('metadata-cleanup')
				)
			).toEqual([]);
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

		it('makes discard win atomically over both success and failure settlement', async () => {
			for (const outcome of ['success', 'failure'] as const) {
				await seedRaw(`discard-${outcome}`, 0, 0);
				const claimed = await claimOne(redis, `discard-${outcome}`, {
					owner: 'sweeper',
					now: 100_000,
					requireDue: true,
					enforceAutoLimit: true,
					autoRetryLimit: 8,
				});
				expect(claimed).not.toBeNull();
				expect(await removeOne(redis, `discard-${outcome}`)).toBe(true);
				expect(await settleClaim(redis, claimed!, outcome, 100_001)).toBe(false);
				expect(await getEntry(redis, `discard-${outcome}`)).toBeNull();
				expect(await redis.zscore(WEBHOOK_DLQ_CREATED_KEY, `discard-${outcome}`)).toBeNull();
				expect(await redis.zscore(WEBHOOK_DLQ_DUE_KEY, `discard-${outcome}`)).toBeNull();
			}
		});
	});

	it('erases evicted raw payloads from every DLQ structure', async () => {
		const one = { ...config, webhookDlqMaxSize: 1 };
		const first = await storeFailed(
			redis,
			createTestEvent({ message: 'raw-rfc822-private-first' }),
			TRANSPORT_FAILURE,
			one
		);
		await storeFailed(
			redis,
			createTestEvent({ message: 'raw-rfc822-private-second' }),
			TRANSPORT_FAILURE,
			one
		);
		expect(await redis.hexists(WEBHOOK_DLQ_ENTRIES_KEY, first)).toBe(0);
		expect(await redis.zscore(WEBHOOK_DLQ_CREATED_KEY, first)).toBeNull();
		expect(await redis.zscore(WEBHOOK_DLQ_DUE_KEY, first)).toBeNull();
		expect(JSON.stringify(await redis.hgetall(WEBHOOK_DLQ_ENTRIES_KEY))).not.toContain(
			'raw-rfc822-private-first'
		);
	});
});
