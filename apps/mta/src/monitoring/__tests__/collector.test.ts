import { describe, it, expect, vi, beforeEach } from 'vitest';
import Redis from 'ioredis-mock';
import {
	registry,
	emailsSentTotal,
	record,
	getIspMetrics,
	getIpMetrics,
} from '../collector.js';

vi.mock('../logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../queue/groups.js', () => ({
	classifyIsp: vi.fn((domain: string) => {
		if (domain.includes('gmail')) return 'gmail';
		return 'other';
	}),
}));

describe('collector', () => {
	let redis: InstanceType<typeof Redis>;

	beforeEach(async () => {
		redis = new Redis();
		await redis.flushall();
		registry.resetMetrics();
	});

	describe('record', () => {
		it('increments Redis ISP and IP metrics', async () => {
			const today = new Date().toISOString().split('T')[0]!;
			await record(redis, 'gmail.com', '10.0.0.1', 'transactional', 'delivered');

			const ispMetrics = await getIspMetrics(redis, 'gmail', today);
			expect(ispMetrics.sent).toBe(1);
			expect(ispMetrics.delivered).toBe(1);

			const ipMetrics = await getIpMetrics(redis, '10.0.0.1', today);
			expect(ipMetrics.sent).toBe(1);
			expect(ipMetrics.delivered).toBe(1);
		});

		it('with durationMs observes histogram and increments counter', async () => {
			await record(redis, 'gmail.com', '10.0.0.1', 'transactional', 'delivered', 1500);

			const metrics = await registry.getMetricsAsJSON();
			const sentMetric = metrics.find((m) => m.name === 'mta_emails_sent_total');
			expect(sentMetric).toBeDefined();
		});
	});

	describe('getIspMetrics', () => {
		it('returns parsed values', async () => {
			const today = new Date().toISOString().split('T')[0]!;
			await record(redis, 'gmail.com', '10.0.0.1', 'transactional', 'delivered');
			await record(redis, 'gmail.com', '10.0.0.1', 'transactional', 'bounced');

			const metrics = await getIspMetrics(redis, 'gmail', today);
			expect(metrics.sent).toBe(2);
			expect(metrics.delivered).toBe(1);
			expect(metrics.bounced).toBe(1);
		});
	});

	describe('getIpMetrics', () => {
		it('returns parsed values', async () => {
			const today = new Date().toISOString().split('T')[0]!;
			await record(redis, 'gmail.com', '10.0.0.5', 'campaign', 'delivered');

			const metrics = await getIpMetrics(redis, '10.0.0.5', today);
			expect(metrics.sent).toBe(1);
			expect(metrics.delivered).toBe(1);
		});
	});
});
