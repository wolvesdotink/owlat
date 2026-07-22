import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis-mock';
import keySlot from 'cluster-key-slot';
import { attachFeedbackProvenance, recordFeedbackProvenance } from '../feedbackProvenance.js';
import { reduce } from '../outcome.js';
import type { EmailJob } from '../../types.js';
import type { BounceAttempt } from '../types.js';

const EIGHT_DAYS_MS = 8 * 24 * 60 * 60 * 1_000;

function job(
	messageId: string,
	deliveryDomain: 'production' | 'member_test',
	recipient = 'recipient@example.com'
): EmailJob {
	return {
		messageId,
		workAttemptId: `work-${messageId}`,
		to: recipient,
		from: 'sender@example.org',
		subject: 'Subject',
		html: '<p>Body</p>',
		ipPool: 'transactional',
		organizationId: 'org-1',
		deliveryDomain,
		dkimDomain: 'example.org',
	};
}

function dsn(messageId: string): BounceAttempt {
	return {
		kind: 'dsn_attributed',
		bounce: {
			type: 'bounced',
			bounceType: 'hard',
			message: '550 no such user',
			originalMessageId: messageId,
		},
	};
}

function redacted(recipient = 'recipient@example.com'): BounceAttempt {
	return {
		kind: 'fbl',
		arf: {
			type: 'complained',
			bounceType: 'hard',
			message: 'Spam complaint via ARF from gmail',
			recipient,
		},
	};
}

function attributedFbl(messageId: string): BounceAttempt {
	return {
		kind: 'fbl',
		arf: {
			type: 'complained',
			bounceType: 'hard',
			message: 'Spam complaint via ARF from gmail',
			originalMessageId: messageId,
			recipient: 'recipient@example.com',
		},
	};
}

describe('delayed feedback provenance', () => {
	let redis: InstanceType<typeof Redis>;

	beforeEach(async () => {
		redis = new Redis();
		await redis.flushall();
	});

	afterEach(async () => {
		vi.useRealTimers();
		await redis.quit();
	});

	it.each([dsn('member-dsn'), attributedFbl('member-fbl-id'), redacted()] as const)(
		'keeps delayed member DSN/FBL effects out of production state',
		async (attempt) => {
			const messageId =
				attempt.kind === 'dsn_attributed'
					? 'member-dsn'
					: attempt.arf.originalMessageId
						? 'member-fbl-id'
						: 'member-fbl';
			await recordFeedbackProvenance(redis, job(messageId, 'member_test'));
			const attributed = await attachFeedbackProvenance(redis, attempt);
			const { effects } = reduce(attributed, {} as never);

			if (attempt.kind === 'fbl' && !attempt.arf.originalMessageId) {
				expect(effects).toEqual([]);
				return;
			}
			expect(effects.map((effect) => effect.kind)).toEqual(['notify_convex']);
			expect(effects[0]).toMatchObject({
				kind: 'notify_convex',
				event: { deliveryDomain: 'member_test' },
			});
		}
	);

	it('treats mixed recipient-only attribution as unknown and non-destructive', async () => {
		await recordFeedbackProvenance(redis, job('production-1', 'production'));
		await recordFeedbackProvenance(redis, job('member-1', 'member_test'));
		const attributed = await attachFeedbackProvenance(redis, redacted());

		expect(attributed.kind === 'fbl' && attributed.arf.feedbackProvenance).toBe('unknown');
		expect(reduce(attributed, {} as never).effects).toEqual([]);
	});

	it('expires exact and redacted indexes after the documented eight-day horizon', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
		await recordFeedbackProvenance(redis, job('expires-1', 'member_test'));
		const keys = await redis.keys('mta:{feedback}:*');
		expect(keys).toHaveLength(2);
		expect(await Promise.all(keys.map((key) => redis.ttl(key)))).toEqual([
			8 * 24 * 60 * 60,
			8 * 24 * 60 * 60,
		]);

		vi.advanceTimersByTime(EIGHT_DAYS_MS + 1);
		const exact = await attachFeedbackProvenance(redis, dsn('expires-1'));
		const recipientOnly = await attachFeedbackProvenance(redis, redacted());
		expect(exact.kind === 'dsn_attributed' && exact.bounce.feedbackProvenance).toBe('unknown');
		expect(recipientOnly.kind === 'fbl' && recipientOnly.arf.feedbackProvenance).toBe('unknown');
		expect(reduce(exact, {} as never).effects).toEqual([]);
		expect(reduce(recipientOnly, {} as never).effects).toEqual([]);
	});

	it('places exact and recipient indexes in one Redis Cluster slot', async () => {
		await recordFeedbackProvenance(redis, job('cluster-1', 'production'));
		const keys = await redis.keys('mta:{feedback}:*');
		expect(new Set(keys.map((key) => keySlot(key))).size).toBe(1);
	});

	it('rejects a partial provenance pipeline commit', async () => {
		const pipeline = {
			setex: vi.fn(),
			zadd: vi.fn(),
			zremrangebyscore: vi.fn(),
			zremrangebyrank: vi.fn(),
			expire: vi.fn(),
			exec: vi.fn().mockResolvedValue([
				[null, 'OK'],
				[new Error('index write failed'), null],
			]),
		};
		for (const method of [
			'setex',
			'zadd',
			'zremrangebyscore',
			'zremrangebyrank',
			'expire',
		] as const) {
			pipeline[method].mockReturnValue(pipeline);
		}
		vi.spyOn(redis, 'pipeline').mockReturnValue(pipeline as never);
		await expect(recordFeedbackProvenance(redis, job('partial', 'production'))).rejects.toThrow(
			'did not commit completely'
		);
	});
});
