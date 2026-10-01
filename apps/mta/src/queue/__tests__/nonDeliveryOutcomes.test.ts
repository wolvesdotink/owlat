import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type { ReservedJob } from 'groupmq';
import type IORedis from 'ioredis';
import { createTestConfig } from '../../__tests__/helpers/fixtures.js';
import type { EmailJob } from '../../types.js';
import {
	getEntry,
	WEBHOOK_DLQ_CREATED_KEY,
	WEBHOOK_DLQ_PROTECTED_KEY,
} from '../../webhooks/dlq.js';
import { emitExpiredBounce } from '../nonDeliveryOutcomes.js';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../monitoring/deliveryLogger.js', () => ({
	logDeliveryEvent: vi.fn().mockResolvedValue(undefined),
}));

const FIRST_ENQUEUED_AT = 1_700_000_000_000;

/** A job retained from before `deliveryDomain` was stamped on every job. */
function retainedJob(): ReservedJob<EmailJob> {
	const data: EmailJob = {
		messageId: 'msg-retained-expiry',
		to: 'user@example.com',
		from: 'sender@owlat.com',
		subject: 'Retained',
		html: '<p>Hello</p>',
		ipPool: 'transactional',
		organizationId: 'org-1',
		dkimDomain: 'owlat.com',
		firstEnqueuedAt: FIRST_ENQUEUED_AT,
	};
	return {
		id: 'job-1',
		groupId: 'transactional:example.com',
		data,
		attempts: 0,
		maxAttempts: 5,
		seq: 1,
		timestamp: FIRST_ENQUEUED_AT,
		orderMs: 0,
		score: 0,
		deadlineAt: 0,
	};
}

describe('emitExpiredBounce', () => {
	let redis: InstanceType<typeof Redis>;
	let originalFetch: typeof globalThis.fetch;

	beforeEach(async () => {
		redis = new Redis();
		await redis.flushall();
		originalFetch = globalThis.fetch;
		// Convex never answers, as if the worker died after the durable handoff:
		// the outbox row stays protected and the queue job is replayed.
		globalThis.fetch = vi.fn(() => new Promise<Response>(() => {})) as typeof fetch;
	});

	afterEach(async () => {
		globalThis.fetch = originalFetch;
		await redis.quit();
	});

	it('replays the terminal callback of a job without deliveryDomain past durable handoff', async () => {
		const config = createTestConfig();
		const deps = { redis: redis as unknown as IORedis, config };
		const job = retainedJob();

		// The event is rebuilt with `deliveryDomain: undefined` on every replay,
		// while the stored row lost that member to JSON serialization.
		await emitExpiredBounce(job, deps, 'example.com', 'other', 1, 'deferred');
		await expect(
			emitExpiredBounce(job, deps, 'example.com', 'other', 2, 'deferred')
		).resolves.toBeUndefined();

		expect(await redis.scard(WEBHOOK_DLQ_PROTECTED_KEY)).toBe(1);
		expect(await redis.zcard(WEBHOOK_DLQ_CREATED_KEY)).toBe(1);
		const [id] = await redis.smembers(WEBHOOK_DLQ_PROTECTED_KEY);
		const entry = await getEntry(redis as unknown as IORedis, id!);
		expect(entry?.event).toEqual({
			event: 'bounced',
			messageId: 'msg-retained-expiry',
			organizationId: 'org-1',
			bounceType: 'soft',
			message: `Message expired after ${config.maxMessageAgeMs}ms without delivery`,
			timestamp: FIRST_ENQUEUED_AT + config.maxMessageAgeMs,
		});
	});
});
