import { beforeEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type { MtaConfig } from '../../config.js';
import { queueConvexWebhook } from '../../webhooks/convexNotifier.js';
import { IP_READINESS_ALERTS_PENDING } from '../ipPool.js';
import { flushPendingIpReadinessAlerts } from '../ipReadinessAlerts.js';

vi.mock('../../webhooks/convexNotifier.js', () => ({
	queueConvexWebhook: vi.fn().mockResolvedValue('outbox-id'),
}));

const EVENT_ID = 'ipv6-readiness-v1:spf:2001:db8::10:7';
const MARKER = [
	'spf',
	'missing-ip6-mechanism',
	'1700000000000',
	'IPv6 SPF regressed',
	'2001:db8::10',
	'7',
].join('\x1f');

describe('pending IP-readiness alert handoff', () => {
	beforeEach(() => vi.mocked(queueConvexWebhook).mockResolvedValue('outbox-id'));

	it('queues the stable event exactly once and removes the marker afterward', async () => {
		const redis = new Redis();
		await redis.hset(IP_READINESS_ALERTS_PENDING, EVENT_ID, MARKER);
		await expect(flushPendingIpReadinessAlerts(redis, {} as MtaConfig)).resolves.toBe(1);
		expect(queueConvexWebhook).toHaveBeenCalledWith(
			expect.objectContaining({
				eventId: EVENT_ID,
				ip: '2001:db8::10',
				eligibilityGeneration: 7,
			}),
			expect.anything(),
			redis,
			EVENT_ID
		);
		expect(await redis.hlen(IP_READINESS_ALERTS_PENDING)).toBe(0);
	});

	it('retains the marker when the durable outbox insert fails', async () => {
		const redis = new Redis();
		await redis.hset(IP_READINESS_ALERTS_PENDING, EVENT_ID, MARKER);
		vi.mocked(queueConvexWebhook).mockRejectedValueOnce(new Error('redis unavailable'));
		await expect(flushPendingIpReadinessAlerts(redis, {} as MtaConfig)).rejects.toThrow(
			'redis unavailable'
		);
		expect(await redis.hexists(IP_READINESS_ALERTS_PENDING, EVENT_ID)).toBe(1);
	});
});
