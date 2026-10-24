import { describe, it, expect, vi, beforeEach } from 'vitest';
import Redis from 'ioredis-mock';
import { registry, emailsSentTotal, record, getIspMetrics, getIpMetrics } from '../collector.js';
import type { FblSourceIspToken } from '../../bounce/fblProcessor.js';

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
			expect(ispMetrics['sent']).toBe(1);
			expect(ispMetrics['delivered']).toBe(1);

			const ipMetrics = await getIpMetrics(redis, '10.0.0.1', today);
			expect(ipMetrics['sent']).toBe(1);
			expect(ipMetrics['delivered']).toBe(1);
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
			expect(metrics['sent']).toBe(2);
			expect(metrics['delivered']).toBe(1);
			expect(metrics['bounced']).toBe(1);
		});
	});

	describe('getIpMetrics', () => {
		it('returns parsed values', async () => {
			const today = new Date().toISOString().split('T')[0]!;
			await record(redis, 'gmail.com', '10.0.0.5', 'campaign', 'delivered');

			const metrics = await getIpMetrics(redis, '10.0.0.5', today);
			expect(metrics['sent']).toBe(1);
			expect(metrics['delivered']).toBe(1);
		});
	});

	describe('recordFblComplaintByCampaign', () => {
		const NAME = 'mta_fbl_complaints_by_campaign_total';

		// The campaign budget is per process, so each case loads a fresh module.
		async function freshCollector() {
			vi.resetModules();
			return import('../collector.js');
		}

		async function series(collector: Awaited<ReturnType<typeof freshCollector>>) {
			const metric = (await collector.registry.getMetricsAsJSON()).find((m) => m.name === NAME);
			return metric?.values ?? [];
		}

		it('caps the campaign label and keeps every complaint in the total', async () => {
			const collector = await freshCollector();
			const complaints = collector.CAMPAIGN_LABEL_LIMIT * 5;
			for (let i = 0; i < complaints; i++) {
				collector.recordFblComplaintByCampaign(`campaign_${i}`, 'yahoo');
			}
			// A campaign that got a label before the budget ran out keeps it.
			collector.recordFblComplaintByCampaign('campaign_0', 'yahoo');

			const values = await series(collector);
			expect(values).toHaveLength(collector.CAMPAIGN_LABEL_LIMIT + 1);
			expect(values.reduce((sum, v) => sum + v.value, 0)).toBe(complaints + 1);
			expect(values.find((v) => v.labels['campaign'] === 'campaign_0')?.value).toBe(2);
			expect(
				values.find((v) => v.labels['campaign'] === collector.CAMPAIGN_OVERFLOW_LABEL)?.value
			).toBe(complaints - collector.CAMPAIGN_LABEL_LIMIT);
		});

		it('keeps classifier ISP tokens and files anything else under unknown', async () => {
			const collector = await freshCollector();
			// Typed as a Record so a new classifier token fails typecheck here.
			const tokens: Record<FblSourceIspToken | 'unknown', true> = {
				microsoft: true,
				yahoo: true,
				aol: true,
				comcast: true,
				google: true,
				mailru: true,
				unknown: true,
			};
			for (const isp of Object.keys(tokens)) collector.recordFblComplaintByCampaign('camp', isp);
			collector.recordFblComplaintByCampaign('camp', 'evil.example');

			const values = await series(collector);
			expect(values.map((v) => v.labels['isp']).sort()).toEqual(Object.keys(tokens).sort());
			expect(values.find((v) => v.labels['isp'] === 'unknown')?.value).toBe(2);
		});
	});
});
