/**
 * A CAPPED IP DEFERS TO THE NEXT CAP WINDOW, not to a blind five minutes
 * (deliverability plan P3-7).
 *
 * The warming cap is a per-UTC-DAY budget, so an IP that has spent today's cap
 * gets nothing back until the day rolls over. The shipped phase re-queued every
 * withheld attempt after 300 s, which on a capped IP means the entire deferred
 * backlog re-enters Redis every five minutes for the rest of the day to reach
 * the same verdict every time.
 *
 * THE ASSERTION IS THE DEFERRAL TARGET, NOT A TIMING. A churn test that measured
 * elapsed time would be a flake; what is actually true and worth pinning is that
 * the deferral lands on the next cap window, and therefore that the number of
 * re-queues before capacity returns is ONE instead of one per five minutes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Redis from 'ioredis-mock';
import type RealRedis from 'ioredis';

vi.mock('../../../intelligence/warming.js', () => ({
	checkCap: vi.fn(),
	ensureWarmingReservation: vi.fn(),
}));
vi.mock('../../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { warmingCapPhase } from '../warmingCap.js';
import * as warming from '../../../intelligence/warming.js';
import {
	capDeferDelayMs,
	MAX_CAP_DEFER_MS,
	MINIMUM_CAP_DEFER_MS,
	nextCapWindowDelayMs,
} from '../../../intelligence/warmingCapWindow.js';
import { warmingProviderStateKey } from '../../../intelligence/warmingKeys.js';
import type { CtxWithIp, PhaseDeps } from '../../types.js';
import type { DestinationProviderKey } from '@owlat/shared/deliverabilityRouting';
import type { EmailJob, IpPoolType } from '../../../types.js';
import type { MtaConfig } from '../../../config.js';

const IP = '10.0.0.7';
const UTC_DATE = '2026-07-27';
/** Mid-afternoon: far enough from both boundaries that the delay is unambiguous. */
const NOW_ISO = `${UTC_DATE}T14:00:00.000Z`;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** The blind delay the shipped phase used for a cap withholding. */
const SHIPPED_BLIND_DEFER_MS = 300_000;

function makeCtx(
	options: { pool?: IpPoolType; providerKey?: DestinationProviderKey } = {}
): CtxWithIp {
	const pool = options.pool ?? 'transactional';
	const providerKey = options.providerKey ?? 'other';
	const job: EmailJob = {
		messageId: 'msg-1',
		to: 'user@example.com',
		from: 'sender@owlat.com',
		subject: 'Test',
		html: '<p>Hello</p>',
		ipPool: pool,
		organizationId: 'org-1',
		dkimDomain: 'owlat.com',
	};
	return {
		job,
		domain: 'example.com',
		destination: {
			recipientDomain: 'example.com',
			providerKey,
			throttleKey: 'example.com',
			mx: {
				status: 'deliverable',
				source: 'mx',
				hosts: [{ exchange: 'mx.example.com', priority: 0 }],
			},
			daneDiscoveryAuthenticated: true,
		},
		fromDomain: 'owlat.com',
		pool,
		dedicatedIp: undefined,
		ip: IP,
		eligibilityGeneration: 1,
	};
}

let deps: PhaseDeps;
let redis: RealRedis;

beforeEach(async () => {
	vi.clearAllMocks();
	vi.useFakeTimers();
	vi.setSystemTime(new Date(NOW_ISO));
	redis = new Redis() as unknown as RealRedis;
	await redis.flushall();
	deps = { redis, config: {} as MtaConfig };
});

afterEach(() => {
	vi.useRealTimers();
});

describe('capDeferDelayMs', () => {
	it('is the next cap window, bounded so intraday capacity is never stranded', () => {
		const now = Date.parse(NOW_ISO);
		expect(nextCapWindowDelayMs(now)).toBe(10 * 60 * 60 * 1000);
		expect(capDeferDelayMs(now)).toBe(MAX_CAP_DEFER_MS);
	});

	it('takes the window when the window is the nearer of the two', () => {
		const nearMidnight = Date.parse(`${UTC_DATE}T23:40:00.000Z`);
		expect(capDeferDelayMs(nearMidnight)).toBe(20 * 60 * 1000);
	});
});

describe('nextCapWindowDelayMs', () => {
	it('lands on the next UTC day boundary', () => {
		const now = Date.parse(NOW_ISO);
		expect(nextCapWindowDelayMs(now)).toBe(10 * 60 * 60 * 1000);
		expect((now + nextCapWindowDelayMs(now)) % MS_PER_DAY).toBe(0);
	});

	it('never returns a near-zero delay at the boundary — that is the hot loop', () => {
		const justBeforeMidnight = Date.parse(`${UTC_DATE}T23:59:59.900Z`);
		expect(nextCapWindowDelayMs(justBeforeMidnight)).toBe(MINIMUM_CAP_DEFER_MS);
	});

	it('a clock it cannot read still yields a deferral, never NaN', () => {
		expect(nextCapWindowDelayMs(Number.NaN)).toBe(MINIMUM_CAP_DEFER_MS);
	});
});

describe('warmingCapPhase — deferral target', () => {
	it('defers a spent per-IP daily cap to the next cap window', async () => {
		vi.mocked(warming.checkCap).mockResolvedValueOnce({
			allowed: false,
			sentToday: 100,
			dailyCap: 100,
		});
		const out = await warmingCapPhase.run(deps, makeCtx());
		expect(out.kind).toBe('defer');
		if (out.kind !== 'defer') return;
		expect(out.delayMs).toBe(capDeferDelayMs(Date.now()));
		expect(out.delayMs).not.toBe(SHIPPED_BLIND_DEFER_MS);
	});

	it('defers a spent per-(IP x provider) cap to the next cap window too', async () => {
		vi.mocked(warming.checkCap).mockResolvedValue({
			allowed: true,
			sentToday: 0,
			dailyCap: 1_000,
		});
		const providerKey: DestinationProviderKey = 'gmail';
		// A tightened per-provider multiplier with the day's allowance already
		// spent: gate 1 passes, gate 2 withholds — the case a per-IP-only test
		// cannot reach.
		await redis.hset(
			warmingProviderStateKey(IP, providerKey),
			'sentToday',
			'999999',
			'sentTodayReset',
			UTC_DATE,
			'capMultiplier',
			'0.1'
		);

		const out = await warmingCapPhase.run(deps, makeCtx({ providerKey }));
		expect(out.kind).toBe('defer');
		if (out.kind !== 'defer') return;
		expect(out.delayMs).toBe(capDeferDelayMs(Date.now()));
	});

	it('an order of magnitude fewer re-queues before capacity returns', async () => {
		vi.mocked(warming.checkCap).mockResolvedValueOnce({
			allowed: false,
			sentToday: 100,
			dailyCap: 100,
		});
		const out = await warmingCapPhase.run(deps, makeCtx());
		expect(out.kind).toBe('defer');
		if (out.kind !== 'defer') return;
		const msUntilCapacity = nextCapWindowDelayMs(Date.now());
		const shippedRequeues = Math.ceil(msUntilCapacity / SHIPPED_BLIND_DEFER_MS);
		const requeues = Math.ceil(msUntilCapacity / out.delayMs);
		// The churn the change exists to remove: 120 re-asks of an unchanged
		// verdict become 10, and the last of them is the one that finds capacity.
		expect(requeues).toBe(10);
		expect(shippedRequeues).toBeGreaterThan(100);
		expect(requeues * 10).toBeLessThan(shippedRequeues);
	});
});
