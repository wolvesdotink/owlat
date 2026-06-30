import { describe, it, expect, vi } from 'vitest';
import Redis from 'ioredis-mock';
import {
	logDeliveryEvent,
	queryDeliveryLogs,
	getDeliveryLogStats,
	getMessageEvents,
} from '../deliveryLogger.js';
import type { DeliveryEvent } from '../deliveryLogger.js';
import { createTestConfig } from '../../__tests__/helpers/fixtures.js';

vi.mock('../logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Check if ioredis-mock supports streams
const STREAMS_SUPPORTED = await (async () => {
	try {
		const r = new Redis();
		await r.xadd('test-stream', '*', 'key', 'val');
		await r.del('test-stream');
		return true;
	} catch {
		return false;
	}
})();

function createEvent(overrides?: Partial<DeliveryEvent>): DeliveryEvent {
	return {
		messageId: 'msg-001',
		to: 'recipient@example.com',
		from: 'sender@example.com',
		orgId: 'org-1',
		status: 'delivered',
		domain: 'example.com',
		...overrides,
	};
}

describe.skipIf(!STREAMS_SUPPORTED)('deliveryLogger', () => {
	const config = createTestConfig();

	describe('logDeliveryEvent', () => {
		it('writes to stream', async () => {
			const redis = new Redis();
			await logDeliveryEvent(redis, createEvent(), config);

			const today = new Date().toISOString().split('T')[0]!;
			const entries = await redis.xrange(`mta:delivery-log:${today}`, '-', '+');
			expect(entries.length).toBeGreaterThanOrEqual(1);
		});
	});

	describe('queryDeliveryLogs', () => {
		it('returns entries', async () => {
			const redis = new Redis();
			await logDeliveryEvent(redis, createEvent({ messageId: 'q-1' }), config);
			await logDeliveryEvent(redis, createEvent({ messageId: 'q-2' }), config);

			const result = await queryDeliveryLogs(redis, {});
			expect(result.entries.length).toBeGreaterThanOrEqual(2);
		});
	});

	describe('getDeliveryLogStats', () => {
		it('returns status counts', async () => {
			const redis = new Redis();
			const today = new Date().toISOString().split('T')[0]!;
			await logDeliveryEvent(redis, createEvent({ status: 'delivered' }), config);
			await logDeliveryEvent(redis, createEvent({ status: 'bounced' }), config);

			const stats = await getDeliveryLogStats(redis, today);
			expect(stats.total).toBeGreaterThanOrEqual(2);
			expect(stats.delivered).toBeGreaterThanOrEqual(1);
			expect(stats.bounced).toBeGreaterThanOrEqual(1);
		});
	});

	describe('getMessageEvents', () => {
		it('finds events by messageId', async () => {
			const redis = new Redis();
			await logDeliveryEvent(redis, createEvent({ messageId: 'find-me' }), config);
			await logDeliveryEvent(redis, createEvent({ messageId: 'other' }), config);

			const events = await getMessageEvents(redis, 'find-me');
			expect(events.length).toBeGreaterThanOrEqual(1);
			expect(events.every((e) => e.messageId === 'find-me')).toBe(true);
		});
	});
});
