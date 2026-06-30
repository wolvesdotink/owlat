import { describe, it, expect, vi, beforeEach } from 'vitest';
import Redis from 'ioredis-mock';
import {
	storeFailed,
	listFailed,
	getEntry,
	removeOne,
	updateEntry,
	getStats,
	getAllIds,
} from '../dlq.js';
import { createTestConfig } from '../../__tests__/helpers/fixtures.js';
import type { MtaWebhookEvent } from '../../types.js';

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
			const dlqId = await storeFailed(redis, createTestEvent(), 'Connection refused', config);
			expect(dlqId).toBeTruthy();
			expect(typeof dlqId).toBe('string');
		});
	});

	describe('getEntry', () => {
		it('retrieves entry by dlqId', async () => {
			const dlqId = await storeFailed(redis, createTestEvent(), 'Timeout', config);

			const entry = await getEntry(redis, dlqId);
			expect(entry).not.toBeNull();
			expect(entry!.dlqId).toBe(dlqId);
			expect(entry!.error).toBe('Timeout');
			expect(entry!.event.event).toBe('bounced');
		});

		it('returns null for non-existent dlqId', async () => {
			const entry = await getEntry(redis, 'non-existent-id');
			expect(entry).toBeNull();
		});
	});

	describe('listFailed', () => {
		it('returns entries newest-first', async () => {
			await storeFailed(redis, createTestEvent({ messageId: 'msg-1' }), 'err1', config);
			await storeFailed(redis, createTestEvent({ messageId: 'msg-2' }), 'err2', config);
			await storeFailed(redis, createTestEvent({ messageId: 'msg-3' }), 'err3', config);

			const result = await listFailed(redis);
			expect(result.entries.length).toBe(3);
			expect(result.total).toBe(3);
			// Newest first: createdAt of first entry >= createdAt of last
			expect(result.entries[0]!.createdAt).toBeGreaterThanOrEqual(result.entries[2]!.createdAt);
		});
	});

	describe('removeOne', () => {
		it('deletes entry and returns true', async () => {
			const dlqId = await storeFailed(redis, createTestEvent(), 'err', config);

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
			const dlqId = await storeFailed(redis, createTestEvent(), 'original', config);
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
			await storeFailed(redis, createTestEvent(), 'e1', config);
			await storeFailed(redis, createTestEvent(), 'e2', config);

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
			const id1 = await storeFailed(redis, createTestEvent(), 'e1', config);
			const id2 = await storeFailed(redis, createTestEvent(), 'e2', config);

			const ids = await getAllIds(redis);
			expect(ids).toContain(id1);
			expect(ids).toContain(id2);
		});
	});
});
