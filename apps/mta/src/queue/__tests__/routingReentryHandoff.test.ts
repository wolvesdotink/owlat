import { beforeEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type RealRedis from 'ioredis';
import type { MtaConfig } from '../../config.js';
import type { EmailJob } from '../../types.js';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../webhooks/convexNotifier.js', () => ({
	queueConvexWebhook: vi.fn(async () => 'outbox-1'),
}));
vi.mock('../routingReservations.js', () => ({
	releaseRoutingReservations: vi.fn(async () => undefined),
}));

import { queueConvexWebhook } from '../../webhooks/convexNotifier.js';
import { handoffRoutingReentry, resumeRoutingReentryHandoff } from '../routingReentryHandoff.js';

const KEY = 'mta:routing-reentry-handoffs:job-1';
const config = {} as MtaConfig;

const job = {
	messageId: 'msg-001',
	to: 'user@example.com',
	from: 'sender@example.com',
	subject: 'Test',
	html: '<p>Hello</p>',
	ipPool: 'transactional',
	organizationId: 'org-1',
	dkimDomain: 'example.com',
	deliveryDomain: 'production',
	workAttemptId: 'work-attempt-1',
	routingReentryToken: 'reentry-token',
	routingReentry: {
		envelopeInput: { kind: 'transactional' },
		retryState: { attempt: 1, startedAt: 1_700_000_000_000, idempotencyKey: 'msg-001' },
	},
} as EmailJob;

const reserved = {
	state: 'reserved',
	messageId: 'msg-001',
	workAttemptId: 'work-attempt-1',
	routingReentryReason: 'circuit_breaker_changed',
	timestamp: 1_700_000_000_000,
	reservedAt: 1_700_000_000_000,
};

describe('routing re-entry handoff receipts', () => {
	let redis: RealRedis;

	beforeEach(() => {
		redis = new Redis() as unknown as RealRedis;
		vi.mocked(queueConvexWebhook).mockClear();
	});

	it('finishes a reserved handoff with its frozen payload and keeps unknown fields', async () => {
		await redis.set(KEY, JSON.stringify({ ...reserved, addedLater: 'kept' }));

		await expect(resumeRoutingReentryHandoff('job-1', job, { redis, config })).resolves.toBe(true);
		expect(queueConvexWebhook).toHaveBeenCalledWith(
			expect.objectContaining({
				routingReentryReason: 'circuit_breaker_changed',
				timestamp: 1_700_000_000_000,
			}),
			config,
			redis,
			'routing-reentry:work-attempt-1:reentry-token'
		);
		expect(JSON.parse((await redis.get(KEY))!)).toMatchObject({
			state: 'accepted',
			addedLater: 'kept',
		});
	});

	it.each<[string, unknown]>([
		['null', null],
		['an array', [reserved]],
		['a missing workAttemptId', { ...reserved, workAttemptId: undefined }],
		['an unknown reason', { ...reserved, routingReentryReason: 'later_reason' }],
		['a non-numeric timestamp', { ...reserved, timestamp: '1700000000000' }],
	])('never treats a receipt with %s as a handoff', async (_label, blob) => {
		const raw = JSON.stringify(blob);
		await redis.set(KEY, raw);

		await expect(resumeRoutingReentryHandoff('job-1', job, { redis, config })).resolves.toBe(false);
		await expect(
			handoffRoutingReentry(job, { redis, config }, 'circuit breaker', 'job-1')
		).rejects.toThrow('unreadable');
		expect(queueConvexWebhook).not.toHaveBeenCalled();
		expect(await redis.get(KEY)).toBe(raw);
	});
});
