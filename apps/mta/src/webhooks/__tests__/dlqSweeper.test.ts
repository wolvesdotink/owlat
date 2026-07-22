import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Redis from 'ioredis';
import type { MtaConfig } from '../../config.js';

const claimEligible = vi.hoisted(() => vi.fn());
const settleClaim = vi.hoisted(() => vi.fn());
const notifyConvex = vi.hoisted(() => vi.fn());

vi.mock('../dlq.js', () => ({ claimEligible, settleClaim }));
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
		claim: { owner: 'sweeper:test', version: 1, expiresAt: 2_000_000 },
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	settleClaim.mockResolvedValue(true);
});

describe('automatic webhook DLQ recovery', () => {
	it('retries one bounded oldest page, deleting success and advancing failure', async () => {
		claimEligible.mockResolvedValue([entry(), entry({ dlqId: 'dlq-2', attempts: 2 })]);
		notifyConvex.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

		expect(await sweepWebhookDlq(redis, config, 1_000_000)).toEqual({
			delivered: 1,
			attempted: 2,
		});
		expect(claimEligible).toHaveBeenCalledWith(
			redis,
			expect.objectContaining({
				now: 1_000_000,
				limit: WEBHOOK_DLQ_SWEEP_BATCH_SIZE,
				autoRetryLimit: WEBHOOK_DLQ_AUTO_RETRY_LIMIT,
			})
		);
		expect(settleClaim).toHaveBeenNthCalledWith(
			1,
			redis,
			expect.objectContaining({ dlqId: 'dlq-1' }),
			'success',
			1_000_000
		);
		expect(settleClaim).toHaveBeenNthCalledWith(
			2,
			redis,
			expect.objectContaining({ dlqId: 'dlq-2' }),
			'failure',
			1_000_000
		);
	});

	it('leaves exhausted and not-yet-due entries inspectable without retrying', async () => {
		claimEligible.mockResolvedValue([]);
		expect(await sweepWebhookDlq(redis, config, 1_000_000)).toEqual({
			delivered: 0,
			attempted: 0,
		});
		expect(notifyConvex).not.toHaveBeenCalled();
		expect(settleClaim).not.toHaveBeenCalled();
	});

	it('uses bounded exponential backoff', () => {
		expect(webhookDlqRetryDelayMs(0)).toBe(60_000);
		expect(webhookDlqRetryDelayMs(2)).toBe(240_000);
		expect(webhookDlqRetryDelayMs(99)).toBe(3_600_000);
	});
});
