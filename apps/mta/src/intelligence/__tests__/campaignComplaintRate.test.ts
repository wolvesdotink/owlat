import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Redis from 'ioredis-mock';
import type RealRedis from 'ioredis';
import {
	recordDelivery,
	recordComplaint,
	getStats,
	parseCampaignFromFeedbackId,
	CAMPAIGN_COMPLAINT_THRESHOLD,
	CAMPAIGN_MIN_DELIVERIES,
} from '../campaignComplaintRate.js';
import { durableEffectIdentity } from '../../lib/effectCheckpoint.js';

describe('campaignComplaintRate', () => {
	let redis: RealRedis;

	beforeEach(() => {
		redis = new Redis() as unknown as RealRedis;
	});

	afterEach(async () => {
		await redis.flushall();
	});

	describe('threshold === Gmail 2024 spam-rate ceiling', () => {
		it('is 0.3%', () => {
			expect(CAMPAIGN_COMPLAINT_THRESHOLD).toBe(0.003);
		});
	});

	describe('recordDelivery / getStats', () => {
		it('accumulates deliveries as the rate denominator', async () => {
			await recordDelivery(redis, 'c1', 500);
			await recordDelivery(redis, 'c1', 500);
			const stats = await getStats(redis, 'c1');
			expect(stats.delivered).toBe(1000);
			expect(stats.complaints).toBe(0);
			expect(stats.rate).toBe(0);
		});

		it('increments once when a durable delivery effect is replayed', async () => {
			const identity = durableEffectIdentity('smtp-attempt:test', 'campaign-delivery:c1');

			await recordDelivery(redis, 'c1', 1, identity);
			await recordDelivery(redis, 'c1', 1, identity);

			expect((await getStats(redis, 'c1')).delivered).toBe(1);
		});

		it('does not duplicate a delivery after its Redis commit response is lost', async () => {
			const identity = durableEffectIdentity('smtp-attempt:test', 'campaign-delivery:lost');
			const committedEval = redis.eval.bind(redis) as (...args: unknown[]) => Promise<unknown>;
			let loseResponse = true;
			(redis as unknown as { eval: (...args: unknown[]) => Promise<unknown> }).eval = async (
				...args
			) => {
				const result = await committedEval(...args);
				if (loseResponse && String(args[0]).includes("redis.call('EXISTS', KEYS[2])")) {
					loseResponse = false;
					throw new Error('simulated lost Redis response');
				}
				return result;
			};

			await expect(recordDelivery(redis, 'c1', 1, identity)).rejects.toThrow(
				'simulated lost Redis response'
			);
			await expect(recordDelivery(redis, 'c1', 1, identity)).resolves.toBeUndefined();
			expect((await getStats(redis, 'c1')).delivered).toBe(1);
		});
	});

	describe('recordComplaint', () => {
		it('increments once when the same durable complaint effect is replayed', async () => {
			await recordDelivery(redis, 'c1', 1000);
			const identity = durableEffectIdentity('fbl-complaint:test', 'campaign-rate:c1');

			const first = await recordComplaint(redis, 'c1', identity);
			const replay = await recordComplaint(redis, 'c1', identity);

			expect(first.complaints).toBe(1);
			expect(replay.complaints).toBe(1);
			expect(await getStats(redis, 'c1')).toMatchObject({ complaints: 1, delivered: 1000 });
		});

		it('returns the original threshold crossing after a committed response is lost', async () => {
			await recordDelivery(redis, 'c1', 1000);
			for (let index = 0; index < 3; index++) await recordComplaint(redis, 'c1');
			const identity = durableEffectIdentity('fbl-complaint:test', 'campaign-rate:crossing');
			const committedEval = redis.eval.bind(redis) as (...args: unknown[]) => Promise<unknown>;
			let loseResponse = true;
			(redis as unknown as { eval: (...args: unknown[]) => Promise<unknown> }).eval = async (
				...args
			) => {
				const result = await committedEval(...args);
				if (loseResponse && String(args[0]).includes("redis.call('EXISTS', KEYS[2])")) {
					loseResponse = false;
					throw new Error('simulated lost Redis response');
				}
				return result;
			};

			await expect(recordComplaint(redis, 'c1', identity)).rejects.toThrow(
				'simulated lost Redis response'
			);
			await expect(recordComplaint(redis, 'c1', identity)).resolves.toMatchObject({
				complaints: 4,
				thresholdCrossed: true,
			});
			expect((await getStats(redis, 'c1')).complaints).toBe(4);
		});

		it('returns the running rate (complaints / deliveries)', async () => {
			await recordDelivery(redis, 'c1', 1000);
			const r1 = await recordComplaint(redis, 'c1');
			expect(r1.complaints).toBe(1);
			expect(r1.delivered).toBe(1000);
			expect(r1.rate).toBeCloseTo(0.001, 6);
		});

		it('does not cross the threshold at exactly 0.3% (3/1000) — strictly-greater', async () => {
			await recordDelivery(redis, 'c1', 1000);
			let crossed = false;
			for (let i = 0; i < 3; i++) {
				crossed = (await recordComplaint(redis, 'c1')).thresholdCrossed;
			}
			expect(crossed).toBe(false);
		});

		it('crosses the threshold above 0.3% (4/1000 = 0.4%) exactly once', async () => {
			await recordDelivery(redis, 'c1', 1000);
			const crossings: boolean[] = [];
			for (let i = 0; i < 5; i++) {
				crossings.push((await recordComplaint(redis, 'c1')).thresholdCrossed);
			}
			// 1,2,3 = 0.1/0.2/0.3% (false), 4 = 0.4% (crosses), 5 = latched (false)
			expect(crossings).toEqual([false, false, false, true, false]);
		});

		it('does not cross below the min-deliveries floor even at a high ratio', async () => {
			await recordDelivery(redis, 'c1', CAMPAIGN_MIN_DELIVERIES - 1);
			// 1 complaint / 99 ≈ 1% — well over 0.3% but below the delivery floor.
			const r = await recordComplaint(redis, 'c1');
			expect(r.rate).toBeGreaterThan(CAMPAIGN_COMPLAINT_THRESHOLD);
			expect(r.thresholdCrossed).toBe(false);
		});

		it('tracks a complaint even with zero recorded deliveries (rate = complaints)', async () => {
			const r = await recordComplaint(redis, 'orphan');
			expect(r.delivered).toBe(0);
			expect(r.complaints).toBe(1);
			expect(r.rate).toBe(1);
			// Below the min-deliveries floor, so no alert — but it IS now tracked.
			expect(r.thresholdCrossed).toBe(false);
			const stats = await getStats(redis, 'orphan');
			expect(stats.complaints).toBe(1);
		});
	});

	describe('parseCampaignFromFeedbackId', () => {
		// A realistic Convex document id: lowercase base32-ish alphanumeric, 32 chars.
		const CAMPAIGN_ID = 'jh71d9k2m3n4p5q6r7s8t9v0w1x2y3z4';

		it('extracts field 2 from a campaign-stream Feedback-ID', () => {
			expect(parseCampaignFromFeedbackId(`campaign:${CAMPAIGN_ID}:topic:ab12cd`)).toBe(CAMPAIGN_ID);
		});

		it('returns undefined for the txn stream', () => {
			expect(parseCampaignFromFeedbackId('txn:none:none:ab12cd')).toBeUndefined();
		});

		it('returns undefined when the campaign field is the `none` placeholder', () => {
			expect(parseCampaignFromFeedbackId('campaign:none:none:ab12cd')).toBeUndefined();
		});

		it('returns undefined for a malformed (non-4-field) value', () => {
			expect(parseCampaignFromFeedbackId(`campaign:${CAMPAIGN_ID}`)).toBeUndefined();
			expect(parseCampaignFromFeedbackId('')).toBeUndefined();
			expect(parseCampaignFromFeedbackId(undefined)).toBeUndefined();
		});

		it('trims surrounding whitespace', () => {
			expect(parseCampaignFromFeedbackId(`  campaign:${CAMPAIGN_ID}:segment:zz  `)).toBe(
				CAMPAIGN_ID
			);
		});

		// SECURITY: the value is scraped from internet-inbound ARF content and
		// becomes a Prometheus label / Redis key. A forged/oversized field-2 must
		// be rejected so it cannot inflate metric cardinality (memory DoS).
		it('returns undefined for a campaignId outside the doc-id charset', () => {
			// Underscores, uppercase, and other punctuation are not valid Convex ids.
			expect(parseCampaignFromFeedbackId('campaign:camp_42:topic:ab12cd')).toBeUndefined();
			expect(
				parseCampaignFromFeedbackId('campaign:UPPERCASE1234567890abcd:topic:ab12cd')
			).toBeUndefined();
			expect(
				parseCampaignFromFeedbackId('campaign:has space here1234567:topic:ab12cd')
			).toBeUndefined();
		});

		it('returns undefined for a campaignId that is too short', () => {
			expect(parseCampaignFromFeedbackId('campaign:abc123:topic:ab12cd')).toBeUndefined();
		});

		it('returns undefined for an oversized campaignId (bounds per-value cardinality)', () => {
			const oversized = 'a'.repeat(65);
			expect(parseCampaignFromFeedbackId(`campaign:${oversized}:topic:ab12cd`)).toBeUndefined();
			// A pathological multi-kilobyte forged value is also rejected.
			const huge = 'b'.repeat(5000);
			expect(parseCampaignFromFeedbackId(`campaign:${huge}:topic:ab12cd`)).toBeUndefined();
		});
	});
});
