import { describe, it, expect, vi, beforeEach } from 'vitest';
import Redis from 'ioredis-mock';

vi.mock('../../intelligence/circuitBreaker.js', () => ({
	recordOutcome: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../intelligence/domainThrottle.js', () => ({
	recordSuccess: vi.fn().mockResolvedValue(undefined),
	recordReject: vi.fn().mockResolvedValue(undefined),
	recordDefer: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../intelligence/smtpResponse.js', () => ({
	recordResponse: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../intelligence/warming.js', () => ({
	recordSend: vi.fn().mockResolvedValue(undefined),
	recordBounce: vi.fn().mockResolvedValue(undefined),
	recordDeferral: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../intelligence/suppressionList.js', () => ({
	suppress: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../scaling/degradation.js', () => ({
	clearDomainFailure: vi.fn().mockResolvedValue(undefined),
	recordDomainFailure: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../monitoring/collector.js', () => ({
	emailsSentTotal: { inc: vi.fn() },
	record: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../monitoring/deliveryLogger.js', () => ({
	logDeliveryEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../webhooks/convexNotifier.js', () => ({
	notifyConvex: vi.fn().mockResolvedValue(true),
}));
vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { applyEffects, type DispatchEffect } from '../effects.js';
import * as circuitBreaker from '../../intelligence/circuitBreaker.js';
import * as campaignComplaintRate from '../../intelligence/campaignComplaintRate.js';
import * as domainThrottle from '../../intelligence/domainThrottle.js';
import * as smtpResponse from '../../intelligence/smtpResponse.js';
import * as warming from '../../intelligence/warming.js';
import * as suppressionList from '../../intelligence/suppressionList.js';
import * as degradation from '../../scaling/degradation.js';
import * as metrics from '../../monitoring/collector.js';
import { logDeliveryEvent } from '../../monitoring/deliveryLogger.js';
import { notifyConvex } from '../../webhooks/convexNotifier.js';
import type { PhaseDeps } from '../types.js';
import type { MtaConfig } from '../../config.js';

function makeDeps(): PhaseDeps {
	return {
		redis: new Redis() as never,
		config: {} as MtaConfig,
	};
}

beforeEach(async () => {
	vi.clearAllMocks();
	// ioredis-mock shares a backing store across instances — wipe it so the
	// per-test Redis state is clean (the un-mocked campaignComplaintRate writes here).
	await new Redis().flushall();
});

describe('applyEffects — per-effect dispatch', () => {
	it('domain_throttle_success → domainThrottle.recordSuccess', async () => {
		await applyEffects(
			[
				{
					kind: 'domain_throttle_success',
					ip: '10.0.0.1',
					throttleKey: 'gmail',
					providerKey: 'gmail',
				},
			],
			makeDeps()
		);
		expect(domainThrottle.recordSuccess).toHaveBeenCalledWith(
			expect.anything(),
			'10.0.0.1',
			'gmail',
			'gmail'
		);
	});

	it('domain_throttle_reject → domainThrottle.recordReject', async () => {
		await applyEffects(
			[{ kind: 'domain_throttle_reject', ip: '10.0.0.1', throttleKey: 'gmail' }],
			makeDeps()
		);
		expect(domainThrottle.recordReject).toHaveBeenCalledWith(
			expect.anything(),
			'10.0.0.1',
			'gmail'
		);
	});

	it('domain_throttle_defer → domainThrottle.recordDefer', async () => {
		await applyEffects(
			[
				{
					kind: 'domain_throttle_defer',
					ip: '10.0.0.1',
					throttleKey: 'gmail',
					providerKey: 'gmail',
				},
			],
			makeDeps()
		);
		expect(domainThrottle.recordDefer).toHaveBeenCalledWith(
			expect.anything(),
			'10.0.0.1',
			'gmail',
			'gmail'
		);
	});

	it('smtp_response → smtpResponse.recordResponse', async () => {
		await applyEffects(
			[
				{
					kind: 'smtp_response',
					domain: 'gmail.com',
					smtpCode: 250,
					enhancedCode: '2.0.0',
				},
			],
			makeDeps()
		);
		expect(smtpResponse.recordResponse).toHaveBeenCalledWith(
			expect.anything(),
			'gmail.com',
			250,
			'2.0.0'
		);
	});

	it('circuit_breaker_outcome → circuitBreaker.recordOutcome', async () => {
		const deps = makeDeps();
		await applyEffects(
			[{ kind: 'circuit_breaker_outcome', orgId: 'org-1', outcome: 'bounced' }],
			deps
		);
		expect(circuitBreaker.recordOutcome).toHaveBeenCalledWith(
			expect.anything(),
			'org-1',
			'bounced',
			deps.config
		);
	});

	// PR-15: campaign_delivery_record bumps the per-campaign delivered counter
	// (the real campaignComplaintRate module runs against ioredis-mock here).
	it('campaign_delivery_record → per-campaign delivered counter in redis', async () => {
		const deps = makeDeps();
		await applyEffects([{ kind: 'campaign_delivery_record', campaignId: 'camp_d' }], deps);
		const stats = await campaignComplaintRate.getStats(deps.redis as never, 'camp_d');
		expect(stats.delivered).toBe(1);
	});

	it('warming_record dispatches by result kind', async () => {
		const deps = makeDeps();
		await applyEffects(
			[
				{ kind: 'warming_record', ip: '10.0.0.1', result: 'send' },
				{ kind: 'warming_record', ip: '10.0.0.2', result: 'bounce' },
				{ kind: 'warming_record', ip: '10.0.0.3', result: 'deferral' },
			],
			deps
		);
		expect(warming.recordSend).toHaveBeenCalledWith(expect.anything(), '10.0.0.1');
		expect(warming.recordBounce).toHaveBeenCalledWith(expect.anything(), '10.0.0.2');
		expect(warming.recordDeferral).toHaveBeenCalledWith(expect.anything(), '10.0.0.3');
	});

	it('metrics_record → metrics.record with the full arg list', async () => {
		await applyEffects(
			[
				{
					kind: 'metrics_record',
					domain: 'gmail.com',
					ip: '10.0.0.1',
					pool: 'transactional',
					outcome: 'delivered',
					durationMs: 421,
					providerKey: 'gmail',
				},
			],
			makeDeps()
		);
		expect(metrics.record).toHaveBeenCalledWith(
			expect.anything(),
			'gmail.com',
			'10.0.0.1',
			'transactional',
			'delivered',
			421,
			'gmail'
		);
	});

	it('metrics_counter_inc → emailsSentTotal.inc', async () => {
		await applyEffects(
			[{ kind: 'metrics_counter_inc', pool: 'transactional', isp: 'gmail', outcome: 'rejected' }],
			makeDeps()
		);
		expect(metrics.emailsSentTotal.inc).toHaveBeenCalledWith({
			pool: 'transactional',
			isp: 'gmail',
			outcome: 'rejected',
		});
	});

	it('suppress_recipient → suppressionList.suppress', async () => {
		await applyEffects(
			[{ kind: 'suppress_recipient', address: 'user@gmail.com', reason: 'hard_bounce' }],
			makeDeps()
		);
		expect(suppressionList.suppress).toHaveBeenCalledWith(
			expect.anything(),
			'user@gmail.com',
			'hard_bounce'
		);
	});

	it('domain_failure_clear / record → degradation helpers', async () => {
		await applyEffects(
			[
				{ kind: 'domain_failure_clear', domain: 'gmail.com' },
				{ kind: 'domain_failure_record', domain: 'aol.com' },
			],
			makeDeps()
		);
		expect(degradation.clearDomainFailure).toHaveBeenCalledWith(expect.anything(), 'gmail.com');
		expect(degradation.recordDomainFailure).toHaveBeenCalledWith(expect.anything(), 'aol.com');
	});

	it('log_delivery_event → logDeliveryEvent (fire-and-forget)', async () => {
		const event = {
			messageId: 'm-1',
			to: 'a@b.c',
			from: 's@x.y',
			orgId: 'org-1',
			status: 'delivered' as const,
			domain: 'b.c',
		};
		await applyEffects([{ kind: 'log_delivery_event', event }], makeDeps());
		expect(logDeliveryEvent).toHaveBeenCalledWith(expect.anything(), event, expect.anything());
	});

	it('notify_convex → notifyConvex (fire-and-forget)', async () => {
		const event = {
			event: 'sent' as const,
			messageId: 'm-1',
			organizationId: 'org-1',
			timestamp: 1700000000,
		};
		await applyEffects([{ kind: 'notify_convex', event }], makeDeps());
		expect(notifyConvex).toHaveBeenCalledWith(event, expect.anything(), expect.anything());
	});
});

describe('applyEffects — ordering', () => {
	it('suppress_recipient runs after parallel effects', async () => {
		const callOrder: string[] = [];

		vi.mocked(domainThrottle.recordReject).mockImplementation(async () => {
			callOrder.push('domain_throttle_reject');
		});
		vi.mocked(warming.recordBounce).mockImplementation(async () => {
			callOrder.push('warming_bounce');
		});
		vi.mocked(suppressionList.suppress).mockImplementation(async () => {
			callOrder.push('suppress_recipient');
		});

		const effects: DispatchEffect[] = [
			{ kind: 'domain_throttle_reject', ip: '10.0.0.1', domain: 'g.com' },
			{ kind: 'warming_record', ip: '10.0.0.1', result: 'bounce' },
			{ kind: 'suppress_recipient', address: 'a@b.c', reason: 'hard_bounce' },
		];

		await applyEffects(effects, makeDeps());

		const suppressIdx = callOrder.indexOf('suppress_recipient');
		expect(callOrder).toContain('domain_throttle_reject');
		expect(callOrder).toContain('warming_bounce');
		expect(suppressIdx).toBe(callOrder.length - 1);
		expect(suppressIdx).toBeGreaterThan(callOrder.indexOf('domain_throttle_reject'));
		expect(suppressIdx).toBeGreaterThan(callOrder.indexOf('warming_bounce'));
	});

	it('does not await log_delivery_event — applyEffects resolves even if logging hangs', async () => {
		// Make logDeliveryEvent never resolve. If applyEffects awaited it, this test
		// would time out.
		vi.mocked(logDeliveryEvent).mockImplementation(() => new Promise(() => {}));

		const event = {
			messageId: 'm-1',
			to: 'a@b.c',
			from: 's@x.y',
			orgId: 'org-1',
			status: 'delivered' as const,
			domain: 'b.c',
		};

		// Should resolve quickly — log is fire-and-forget.
		await applyEffects([{ kind: 'log_delivery_event', event }], makeDeps());
		expect(logDeliveryEvent).toHaveBeenCalled();
	});

	it('does not await notify_convex — applyEffects resolves even if notify hangs', async () => {
		vi.mocked(notifyConvex).mockImplementation(() => new Promise(() => {}));

		const event = {
			event: 'sent' as const,
			messageId: 'm-1',
			organizationId: 'org-1',
			timestamp: 1700000000,
		};

		await applyEffects([{ kind: 'notify_convex', event }], makeDeps());
		expect(notifyConvex).toHaveBeenCalled();
	});

	it('still surfaces parallel-bucket errors (Promise.all rejection)', async () => {
		vi.mocked(domainThrottle.recordSuccess).mockRejectedValueOnce(new Error('boom'));

		await expect(
			applyEffects(
				[{ kind: 'domain_throttle_success', ip: '10.0.0.1', domain: 'g.com' }],
				makeDeps()
			)
		).rejects.toThrow('boom');
	});
});
