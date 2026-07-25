import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Redis from 'ioredis';
import type { MtaConfig } from '../../config.js';

const listEligibleIds = vi.hoisted(() => vi.fn());
const claimOne = vi.hoisted(() => vi.fn());
const deliverClaimedWebhook = vi.hoisted(() => vi.fn());

vi.mock('../dlq.js', () => ({
	listEligibleIds,
	claimOne,
	WEBHOOK_DLQ_AUTO_RETRY_LIMIT: 8,
}));
vi.mock('../convexNotifier.js', () => ({ deliverClaimedWebhook }));

const { sweepWebhookDlq, WEBHOOK_DLQ_SWEEP_BATCH_SIZE } = await import('../dlqSweeper.js');
const { webhookDlqRetryDelayMs, WEBHOOK_DLQ_AUTO_RETRY_LIMIT } =
	await vi.importActual<typeof import('../dlq.js')>('../dlq.js');

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
	deliverClaimedWebhook.mockResolvedValue(true);
	listEligibleIds.mockResolvedValue([]);
});

describe('automatic webhook DLQ recovery', () => {
	it('retries one bounded oldest page, deleting success and advancing failure', async () => {
		listEligibleIds.mockResolvedValue(['dlq-1', 'dlq-2']);
		claimOne
			.mockResolvedValueOnce(entry())
			.mockResolvedValueOnce(entry({ dlqId: 'dlq-2', attempts: 2 }));
		deliverClaimedWebhook.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

		expect(await sweepWebhookDlq(redis, config, () => 1_000_000)).toEqual({
			delivered: 1,
			attempted: 2,
		});
		expect(listEligibleIds).toHaveBeenCalledWith(
			redis,
			expect.objectContaining({
				now: 1_000_000,
				limit: WEBHOOK_DLQ_SWEEP_BATCH_SIZE,
			})
		);
		expect(claimOne).toHaveBeenCalledTimes(2);
		expect(claimOne).toHaveBeenNthCalledWith(
			1,
			redis,
			'dlq-1',
			expect.objectContaining({ autoRetryLimit: WEBHOOK_DLQ_AUTO_RETRY_LIMIT })
		);
		expect(deliverClaimedWebhook).toHaveBeenNthCalledWith(
			1,
			redis,
			expect.objectContaining({ dlqId: 'dlq-1' }),
			config,
			expect.objectContaining({ deadline: expect.any(Number) })
		);
		expect(deliverClaimedWebhook).toHaveBeenNthCalledWith(
			2,
			redis,
			expect.objectContaining({ dlqId: 'dlq-2' }),
			config,
			expect.objectContaining({ deadline: expect.any(Number) })
		);
	});

	it('leaves exhausted and not-yet-due entries inspectable without retrying', async () => {
		listEligibleIds.mockResolvedValue([]);
		expect(await sweepWebhookDlq(redis, config, () => 1_000_000)).toEqual({
			delivered: 0,
			attempted: 0,
		});
		expect(deliverClaimedWebhook).not.toHaveBeenCalled();
	});

	it('claims each row after prior network work and settles at completion time', async () => {
		listEligibleIds.mockResolvedValue(['dlq-1', 'dlq-2']);
		claimOne.mockResolvedValueOnce(entry()).mockResolvedValueOnce(entry({ dlqId: 'dlq-2' }));
		deliverClaimedWebhook.mockImplementation(async (_redis, _entry, _config, options) => {
			options.clock();
			return true;
		});
		let now = 1_000_000;
		const clock = () => (now += 10_000);
		await sweepWebhookDlq(redis, config, clock);

		expect(claimOne.mock.invocationCallOrder[1]).toBeGreaterThan(
			deliverClaimedWebhook.mock.invocationCallOrder[0]!
		);
		expect(claimOne.mock.calls[0]![2].now).toBe(1_020_000);
		expect(claimOne.mock.calls[1]![2].now).toBe(1_040_000);
	});

	it('uses bounded exponential backoff', () => {
		expect(webhookDlqRetryDelayMs(0)).toBe(60_000);
		expect(webhookDlqRetryDelayMs(2)).toBe(240_000);
		expect(webhookDlqRetryDelayMs(99)).toBe(3_600_000);
	});
});
