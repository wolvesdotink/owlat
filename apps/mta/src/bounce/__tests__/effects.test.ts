import { describe, it, expect, vi, beforeEach } from 'vitest';
import Redis from 'ioredis-mock';
import type { ParsedMessage } from '@owlat/mail-message';

vi.mock('../../intelligence/circuitBreaker.js', () => ({
	recordOutcome: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../monitoring/collector.js', () => ({
	fblComplaintsTotal: { inc: vi.fn() },
	fblComplaintsByCampaignTotal: { inc: vi.fn() },
	unattributedBouncesTotal: { inc: vi.fn() },
}));
vi.mock('../../webhooks/convexNotifier.js', () => ({
	notifyConvex: vi.fn().mockResolvedValue(true),
	queueConvexWebhook: vi.fn().mockResolvedValue('outbox-feedback'),
}));
vi.mock('../../inbound/forwarder.js', () => ({
	forwardToEndpoint: vi.fn().mockResolvedValue(true),
}));
vi.mock('../../inbound/mailboxResolver.js', () => ({
	bumpUsedBytes: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { applyEffects, type BounceEffect } from '../effects.js';
import * as circuitBreaker from '../../intelligence/circuitBreaker.js';
import * as campaignComplaintRate from '../../intelligence/campaignComplaintRate.js';
import * as metrics from '../../monitoring/collector.js';
import { notifyConvex, queueConvexWebhook } from '../../webhooks/convexNotifier.js';
import { forwardToEndpoint } from '../../inbound/forwarder.js';
import { bumpUsedBytes } from '../../inbound/mailboxResolver.js';
import type { PhaseDeps } from '../types.js';
import type { MtaConfig } from '../../config.js';
import type { InboundRoute } from '../../inbound/router.js';

function makeDeps(): PhaseDeps {
	return { redis: new Redis() as never, config: {} as MtaConfig };
}

beforeEach(async () => {
	vi.clearAllMocks();
	vi.mocked(notifyConvex).mockResolvedValue(true);
	vi.mocked(queueConvexWebhook).mockResolvedValue('outbox-feedback');
	// ioredis-mock shares a backing store across instances — wipe it so the
	// per-test Redis state is clean.
	await new Redis().flushall();
});

describe('applyEffects — per-effect dispatch', () => {
	it('circuit_breaker_outcome → circuitBreaker.recordOutcome', async () => {
		const deps = makeDeps();
		await applyEffects(
			[{ kind: 'circuit_breaker_outcome', orgId: 'org-1', outcome: 'complained' }],
			deps
		);
		expect(circuitBreaker.recordOutcome).toHaveBeenCalledWith(
			expect.anything(),
			'org-1',
			'complained',
			deps.config
		);
	});

	it('metric_inc(fbl_complaint) → fblComplaintsTotal.inc with labels', async () => {
		await applyEffects(
			[{ kind: 'metric_inc', metric: 'fbl_complaint', isp: 'microsoft', attributed: 'yes' }],
			makeDeps()
		);
		expect(metrics.fblComplaintsTotal.inc).toHaveBeenCalledWith({
			isp: 'microsoft',
			attributed: 'yes',
		});
	});

	// PR-15: per-campaign complaint counter (distinct from the per-isp counter).
	it('metric_inc(fbl_complaint_by_campaign) → fblComplaintsByCampaignTotal.inc with labels', async () => {
		await applyEffects(
			[
				{
					kind: 'metric_inc',
					metric: 'fbl_complaint_by_campaign',
					campaign: 'camp_1',
					isp: 'yahoo',
				},
			],
			makeDeps()
		);
		expect(metrics.fblComplaintsByCampaignTotal.inc).toHaveBeenCalledWith({
			campaign: 'camp_1',
			isp: 'yahoo',
		});
	});

	it('metric_inc(unattributed_bounce) → unattributedBouncesTotal.inc', async () => {
		await applyEffects([{ kind: 'metric_inc', metric: 'unattributed_bounce' }], makeDeps());
		expect(metrics.unattributedBouncesTotal.inc).toHaveBeenCalled();
	});

	it('fbl_stats_record → daily redis hincrby', async () => {
		const deps = makeDeps();
		await applyEffects([{ kind: 'fbl_stats_record' }], deps);
		const today = new Date().toISOString().split('T')[0];
		const value = await deps.redis.hget(`mta:fbl-stats:${today}`, 'total');
		expect(value).toBe('1');
	});

	it('stage_attachment → redis setex of base64 content', async () => {
		const deps = makeDeps();
		await applyEffects(
			[
				{
					kind: 'stage_attachment',
					redisKey: 'mta:inbound-att:msg-1:0',
					contentBase64: 'AAAA',
					ttlSeconds: 3600,
				},
			],
			deps
		);
		const value = await deps.redis.get('mta:inbound-att:msg-1:0');
		expect(value).toBe('AAAA');
		const ttl = await deps.redis.ttl('mta:inbound-att:msg-1:0');
		expect(ttl).toBeGreaterThan(0);
		expect(ttl).toBeLessThanOrEqual(3600);
	});

	it('forward_to_endpoint → forwarder.forwardToEndpoint', async () => {
		const route: InboundRoute = {
			id: 'r-1',
			domain: 'org.example',
			address: 'inbox',
			mode: 'endpoint',
			endpointUrl: 'https://hook.example',
			createdAt: 0,
		};
		const parsed = { subject: 'x' } as unknown as ParsedMessage;
		const auth = { spfResult: 'pass', dkimResult: 'pass' };
		await applyEffects(
			[{ kind: 'forward_to_endpoint', route, parsed, rcptTo: 'me@org.example', auth }],
			makeDeps()
		);
		expect(forwardToEndpoint).toHaveBeenCalledWith(parsed, route, 'me@org.example', auth);
	});

	it('attributed terminal notify_convex → durable outbox', async () => {
		await applyEffects(
			[
				{
					kind: 'notify_convex',
					event: {
						event: 'complained',
						messageId: 'm-1',
						timestamp: 1700000000,
					},
				},
			],
			makeDeps()
		);
		expect(queueConvexWebhook).toHaveBeenCalledWith(
			expect.objectContaining({ event: 'complained', messageId: 'm-1' }),
			expect.anything(),
			expect.anything(),
			'feedback:m-1:complained'
		);
	});

	it('keeps pending soft and hard bounce callbacks under distinct durable identities', async () => {
		for (const bounceType of ['soft', 'hard'] as const) {
			await applyEffects(
				[
					{
						kind: 'notify_convex',
						event: {
							event: 'bounced',
							messageId: 'm-bounce',
							bounceType,
							timestamp: 1700000000,
						},
					},
				],
				makeDeps()
			);
		}
		expect(queueConvexWebhook).toHaveBeenNthCalledWith(
			1,
			expect.anything(),
			expect.anything(),
			expect.anything(),
			'feedback:m-bounce:bounced:soft'
		);
		expect(queueConvexWebhook).toHaveBeenNthCalledWith(
			2,
			expect.anything(),
			expect.anything(),
			expect.anything(),
			'feedback:m-bounce:bounced:hard'
		);
	});

	it('mailbox_quota_bump → bumpUsedBytes (fire-and-forget)', async () => {
		await applyEffects(
			[{ kind: 'mailbox_quota_bump', address: 'me@org.example', deltaBytes: 1234 }],
			makeDeps()
		);
		expect(bumpUsedBytes).toHaveBeenCalledWith(expect.anything(), 'me@org.example', 1234);
	});
});

describe('applyEffects — fire-and-forget guarantees', () => {
	it('does not await notify_convex — applyEffects resolves even if it hangs', async () => {
		vi.mocked(notifyConvex).mockImplementation(() => new Promise(() => {}));
		await applyEffects(
			[
				{
					kind: 'notify_convex',
					event: { event: 'complained', timestamp: 0 },
				},
			],
			makeDeps()
		);
		expect(notifyConvex).toHaveBeenCalled();
	});

	it('blocks SMTP ACK only until attributed callback persistence completes', async () => {
		let release!: (value: string) => void;
		vi.mocked(queueConvexWebhook).mockImplementation(
			() => new Promise<string>((resolve) => (release = resolve))
		);
		let settled = false;
		const applying = applyEffects(
			[
				{
					kind: 'notify_convex',
					event: { event: 'bounced', messageId: 'dsn-1', timestamp: 0 },
				},
			],
			makeDeps()
		).then(() => (settled = true));
		await Promise.resolve();
		expect(settled).toBe(false);
		release('outbox-feedback');
		await applying;
	});

	it('does not await mailbox_quota_bump — applyEffects resolves even if it hangs', async () => {
		vi.mocked(bumpUsedBytes).mockImplementation(() => new Promise(() => {}));
		await applyEffects(
			[{ kind: 'mailbox_quota_bump', address: 'me@org.example', deltaBytes: 1 }],
			makeDeps()
		);
		expect(bumpUsedBytes).toHaveBeenCalled();
	});

	it('swallows notify_convex rejections so SMTP ACK is never blocked', async () => {
		vi.mocked(notifyConvex).mockRejectedValueOnce(new Error('convex down'));
		await expect(
			applyEffects(
				[{ kind: 'notify_convex', event: { event: 'complained', timestamp: 0 } }],
				makeDeps()
			)
		).resolves.toBeUndefined();
	});

	it('surfaces awaited-bucket errors (Promise.all rejection)', async () => {
		vi.mocked(circuitBreaker.recordOutcome).mockRejectedValueOnce(new Error('boom'));
		await expect(
			applyEffects(
				[{ kind: 'circuit_breaker_outcome', orgId: 'org-1', outcome: 'complained' }],
				makeDeps()
			)
		).rejects.toThrow('boom');
	});
});

// PR-15: per-campaign complaint-rate tracking + 0.3% alert. The
// campaignComplaintRate module is NOT mocked here — it runs against the shared
// ioredis-mock store so the rate math + alert latch are exercised end-to-end.
describe('applyEffects — campaign_complaint_record (per-campaign rate + alert)', () => {
	const CAMPAIGN = 'camp_rate';

	async function complain(deps: PhaseDeps): Promise<void> {
		await applyEffects(
			[{ kind: 'campaign_complaint_record', campaignId: CAMPAIGN, organizationId: 'org-1' }],
			deps
		);
	}

	it('records the complaint into the per-campaign rate window', async () => {
		const deps = makeDeps();
		await campaignComplaintRate.recordDelivery(deps.redis as never, CAMPAIGN, 1000);
		await complain(deps);
		const stats = await campaignComplaintRate.getStats(deps.redis as never, CAMPAIGN);
		expect(stats.delivered).toBe(1000);
		expect(stats.complaints).toBe(1);
		expect(stats.rate).toBeCloseTo(0.001, 6);
	});

	it('does NOT alert below 0.3% (e.g. 2 complaints / 1000 deliveries = 0.2%)', async () => {
		const deps = makeDeps();
		await campaignComplaintRate.recordDelivery(deps.redis as never, CAMPAIGN, 1000);
		await complain(deps);
		await complain(deps);
		expect(notifyConvex).not.toHaveBeenCalled();
	});

	it('alerts (campaign.complaint_rate) exactly once when crossing 0.3% (4/1000 = 0.4%)', async () => {
		const deps = makeDeps();
		// M deliveries (the denominator)
		await campaignComplaintRate.recordDelivery(deps.redis as never, CAMPAIGN, 1000);
		// N complaints: 3 → 0.3% (not strictly over), 4 → 0.4% (over the threshold)
		await complain(deps); // 0.1%
		await complain(deps); // 0.2%
		await complain(deps); // 0.3% — not strictly greater than 0.3%
		expect(notifyConvex).not.toHaveBeenCalled();
		await complain(deps); // 0.4% — crosses
		expect(notifyConvex).toHaveBeenCalledTimes(1);

		const [event] = vi.mocked(notifyConvex).mock.calls[0]!;
		expect(event.event).toBe('campaign.complaint_rate');
		expect(event.campaignId).toBe(CAMPAIGN);
		expect(event.severity).toBe('critical');
		expect(event.complaintRate).toBeCloseTo(0.004, 6);

		// Latched — further complaints in the same window do not re-alert.
		await complain(deps);
		expect(notifyConvex).toHaveBeenCalledTimes(1);
	});

	it('does NOT alert below the min-deliveries floor even at a high ratio', async () => {
		const deps = makeDeps();
		// Only 10 deliveries → 1 complaint is 10%, but below CAMPAIGN_MIN_DELIVERIES.
		await campaignComplaintRate.recordDelivery(deps.redis as never, CAMPAIGN, 10);
		await complain(deps);
		expect(notifyConvex).not.toHaveBeenCalled();
	});
});

describe('applyEffects — batch dispatch', () => {
	it('runs every effect from a heterogeneous list', async () => {
		const deps = makeDeps();
		const effects: BounceEffect[] = [
			{ kind: 'circuit_breaker_outcome', orgId: 'org-1', outcome: 'complained' },
			{ kind: 'metric_inc', metric: 'fbl_complaint', isp: 'yahoo', attributed: 'yes' },
			{
				kind: 'notify_convex',
				event: { event: 'complained', messageId: 'm-1', timestamp: 0 },
			},
			{ kind: 'fbl_stats_record' },
		];
		await applyEffects(effects, deps);
		expect(circuitBreaker.recordOutcome).toHaveBeenCalled();
		expect(metrics.fblComplaintsTotal.inc).toHaveBeenCalled();
		expect(queueConvexWebhook).toHaveBeenCalled();
		const today = new Date().toISOString().split('T')[0];
		expect(await deps.redis.hget(`mta:fbl-stats:${today}`, 'total')).toBe('1');
	});
});
