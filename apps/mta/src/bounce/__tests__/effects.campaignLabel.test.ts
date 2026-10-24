/**
 * The campaign label on `mta_fbl_complaints_by_campaign_total` is bucketed once
 * the per-process budget is spent. That bucketing is Prometheus-only: the
 * campaign's complaint-rate window (and the alert it drives) must still be
 * keyed by the real campaign id. Runs against the real collector.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis-mock';

vi.mock('../../intelligence/circuitBreaker.js', () => ({
	recordOutcome: vi.fn().mockResolvedValue(undefined),
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

import { applyEffects } from '../effects.js';
import * as campaignComplaintRate from '../../intelligence/campaignComplaintRate.js';
import {
	CAMPAIGN_LABEL_LIMIT,
	CAMPAIGN_OVERFLOW_LABEL,
	recordFblComplaintByCampaign,
	registry,
} from '../../monitoring/collector.js';
import type { PhaseDeps } from '../types.js';
import type { MtaConfig } from '../../config.js';

beforeEach(async () => {
	await new Redis().flushall();
});

describe('campaign complaint past the label budget', () => {
	it('is counted under the overflow label but rate-tracked under its own id', async () => {
		for (let i = 0; i < CAMPAIGN_LABEL_LIMIT; i++) {
			recordFblComplaintByCampaign(`earlier_${i}`, 'yahoo');
		}
		const deps: PhaseDeps = { redis: new Redis() as never, config: {} as MtaConfig };
		const LATE = 'camp_late';

		await applyEffects(
			[
				{ kind: 'metric_inc', metric: 'fbl_complaint_by_campaign', campaign: LATE, isp: 'yahoo' },
				{ kind: 'campaign_complaint_record', campaignId: LATE, organizationId: 'org-1' },
			],
			deps
		);

		const metric = (await registry.getMetricsAsJSON()).find(
			(m) => m.name === 'mta_fbl_complaints_by_campaign_total'
		);
		const labels = metric?.values.map((v) => v.labels['campaign']) ?? [];
		expect(labels).not.toContain(LATE);
		expect(labels).toContain(CAMPAIGN_OVERFLOW_LABEL);
		const stats = await campaignComplaintRate.getStats(deps.redis as never, LATE);
		expect(stats.complaints).toBe(1);
	});
});
