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
	recipient = 'recipient@example.com',
	campaignId?: string
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
		...(campaignId ? { headers: { 'Feedback-ID': `campaign:${campaignId}:topic:sender-id` } } : {}),
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

function redacted(recipient = 'recipient@example.com'): Extract<BounceAttempt, { kind: 'fbl' }> {
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

function attributedFbl(messageId: string): Extract<BounceAttempt, { kind: 'fbl' }> {
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

	it('replaces forged ARF tenant and campaign labels with persisted outbound provenance', async () => {
		const trustedCampaign = 'trustedcampaign1234';
		await recordFeedbackProvenance(
			redis,
			job('known-message', 'production', 'recipient@example.com', trustedCampaign)
		);
		const forged: BounceAttempt = {
			kind: 'fbl',
			arf: {
				...attributedFbl('known-message').arf,
				organizationId: 'attacker-organization',
				campaignId: 'attackercampaign9999',
			},
		};

		const attributed = await attachFeedbackProvenance(redis, forged);
		expect(attributed.kind === 'fbl' && attributed.arf).toMatchObject({
			organizationId: 'org-1',
			campaignId: trustedCampaign,
			feedbackProvenance: 'production',
		});
		const campaignEffects = reduce(attributed, {} as never).effects.filter(
			(effect) =>
				effect.kind === 'campaign_complaint_record' ||
				(effect.kind === 'metric_inc' && effect.metric === 'fbl_complaint_by_campaign')
		);
		expect(campaignEffects).toHaveLength(2);
		expect(campaignEffects).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ campaignId: trustedCampaign }),
				expect.objectContaining({ campaign: trustedCampaign }),
			])
		);
	});

	it('creates no campaign effects or Redis state for many forged campaign labels', async () => {
		for (let index = 0; index < 256; index++) {
			const forged: BounceAttempt = {
				kind: 'fbl',
				arf: {
					...redacted(`recipient-${index}@example.com`).arf,
					organizationId: `attacker-org-${index}`,
					campaignId: `forgedcampaign${String(index).padStart(16, '0')}`,
				},
			};
			const attributed = await attachFeedbackProvenance(redis, forged);
			expect(reduce(attributed, {} as never).effects).toEqual([]);
		}

		expect(await redis.keys('mta:campaign-complaints:*')).toEqual([]);
		expect(await redis.keys('mta:campaign-complaint:*')).toEqual([]);
	});

	it('caps the recipient provenance index at 64 known outbound observations', async () => {
		for (let index = 0; index < 96; index++) {
			await recordFeedbackProvenance(
				redis,
				job(`bounded-${index}`, 'production', 'bounded@example.com')
			);
		}
		const [recipientIndex] = (await redis.keys('mta:{feedback}:recipient:*')) as string[];
		expect(recipientIndex).toBeDefined();
		expect(await redis.zcard(recipientIndex!)).toBe(64);
	});

	it.each([
		{ campaignId: 'x'.repeat(200) },
		{ campaignId: 42 },
		{ messageId: 'different-message' },
	])('rejects malformed persisted attribution without creating campaign effects', async (patch) => {
		await recordFeedbackProvenance(
			redis,
			job('corrupt-record', 'production', 'recipient@example.com', 'trustedcampaign1234')
		);
		const [messageKey] = (await redis.keys('mta:{feedback}:message:*')) as string[];
		const stored = JSON.parse((await redis.get(messageKey!))!) as Record<string, unknown>;
		await redis.set(messageKey!, JSON.stringify({ ...stored, ...patch }));

		const attributed = await attachFeedbackProvenance(redis, attributedFbl('corrupt-record'));
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
