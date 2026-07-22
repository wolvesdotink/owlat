import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Redis from 'ioredis';
import type { MtaConfig } from '../../config.js';

const listOldest = vi.hoisted(() => vi.fn());
const removeOne = vi.hoisted(() => vi.fn());
const updateEntry = vi.hoisted(() => vi.fn());
const notifyConvex = vi.hoisted(() => vi.fn());

vi.mock('../dlq.js', () => ({ listOldest, removeOne, updateEntry }));
vi.mock('../convexNotifier.js', () => ({ notifyConvex }));

const {
	sweepWebhookDlq,
	webhookDlqRetryDelayMs,
	WEBHOOK_DLQ_AUTO_RETRY_LIMIT,
	WEBHOOK_DLQ_SWEEP_BATCH_SIZE,
} = await import('../dlqSweeper.js');

const redis = {} as Redis;
const config = {} as MtaConfig;
const event = { event: 'sent', messageId: 'message-1', timestamp: 1 } as const;

function entry(overrides: Record<string, unknown> = {}) {
	return {
		dlqId: 'dlq-1',
		event,
		failure: { category: 'transport' as const },
		attempts: 0,
		createdAt: 0,
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	removeOne.mockResolvedValue(undefined);
	updateEntry.mockResolvedValue(undefined);
});

describe('automatic webhook DLQ recovery', () => {
	it('retries one bounded oldest page, deleting success and advancing failure', async () => {
		listOldest.mockResolvedValue([entry(), entry({ dlqId: 'dlq-2', attempts: 2 })]);
		notifyConvex.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

		expect(await sweepWebhookDlq(redis, config, 1_000_000)).toEqual({
			delivered: 1,
			attempted: 2,
		});
		expect(listOldest).toHaveBeenCalledWith(redis, WEBHOOK_DLQ_SWEEP_BATCH_SIZE);
		expect(removeOne).toHaveBeenCalledWith(redis, 'dlq-1');
		expect(updateEntry).toHaveBeenCalledWith(
			redis,
			expect.objectContaining({ dlqId: 'dlq-2', attempts: 3, lastRetryAt: 1_000_000 })
		);
	});

	it('leaves exhausted and not-yet-due entries inspectable without retrying', async () => {
		listOldest.mockResolvedValue([
			entry({ attempts: WEBHOOK_DLQ_AUTO_RETRY_LIMIT }),
			entry({ dlqId: 'future', attempts: 1, lastRetryAt: 999_999 }),
		]);
		expect(await sweepWebhookDlq(redis, config, 1_000_000)).toEqual({
			delivered: 0,
			attempted: 0,
		});
		expect(notifyConvex).not.toHaveBeenCalled();
		expect(removeOne).not.toHaveBeenCalled();
		expect(updateEntry).not.toHaveBeenCalled();
	});

	it('uses bounded exponential backoff', () => {
		expect(webhookDlqRetryDelayMs(0)).toBe(60_000);
		expect(webhookDlqRetryDelayMs(2)).toBe(240_000);
		expect(webhookDlqRetryDelayMs(99)).toBe(3_600_000);
	});
});
