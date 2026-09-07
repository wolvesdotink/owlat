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
import type { CtxWithIp, PhaseDeps } from '../../types.js';
import {
	recordProviderVolumePressure,
	recordProviderWarmingSend,
} from '../../../intelligence/warmingProviderStore.js';
import { PROVIDER_WARMING_POLICY } from '../../../intelligence/warmingProviderPolicy.js';
import { warmingBulkDailyKey, warmingProviderStateKey } from '../../../intelligence/warmingKeys.js';
import {
	capDeferDelayMs,
	MAX_CAP_DEFER_MS,
	MINIMUM_CAP_DEFER_MS,
	nextCapWindowDelayMs,
} from '../../../intelligence/warmingCapWindow.js';
import { INTRADAY_PACING_POLICY } from '../../../intelligence/warmingPacing.js';
import type { DestinationProviderKey } from '@owlat/shared/deliverabilityRouting';
import type { EmailJob, IpPoolType } from '../../../types.js';
import type { MtaConfig } from '../../../config.js';
import { makeCtxWithIp, makeDestination } from '../../../__tests__/helpers/dispatchCtx.js';
import { createOwlatJob } from '../../../__tests__/helpers/fixtures.js';

const IP = '10.0.0.7';
const UTC_DATE = '2026-07-27';

function makeCtx(
	options: { pool?: IpPoolType; providerKey?: DestinationProviderKey } = {}
): CtxWithIp {
	const pool = options.pool ?? 'transactional';
	return makeCtxWithIp({
		job: createOwlatJob({ ipPool: pool }),
		destination: makeDestination({ providerKey: options.providerKey ?? 'other' }),
		pool,
		ip: IP,
	});
}

let deps: PhaseDeps;
let redis: RealRedis;

beforeEach(async () => {
	vi.clearAllMocks();
	vi.useFakeTimers();
	// 00:10 UTC — the moment of the "burst at the start of the day" scenario.
	vi.setSystemTime(new Date(`${UTC_DATE}T00:10:00.000Z`));
	redis = new Redis() as unknown as RealRedis;
	await redis.flushall();
	deps = { redis, config: {} as MtaConfig };
});

afterEach(() => {
	vi.useRealTimers();
});

describe('warmingCapPhase', () => {
	it('continues when there is remaining warming capacity', async () => {
		vi.mocked(warming.checkCap).mockResolvedValueOnce({
			allowed: true,
			sentToday: 20,
			dailyCap: 100,
		});
		const out = await warmingCapPhase.run(deps, makeCtx());
		expect(out.kind).toBe('continue');
	});

	it('continues for graduated IPs (Infinity cap)', async () => {
		vi.mocked(warming.checkCap).mockResolvedValueOnce({
			allowed: true,
			sentToday: 0,
			dailyCap: Infinity,
		});
		const out = await warmingCapPhase.run(deps, makeCtx());
		expect(out.kind).toBe('continue');
	});

	it('continues the final governed attempt when an old reservation becomes uncapped', async () => {
		const ctx = makeCtx();
		const oldReservation = {
			ip: ctx.ip,
			messageId: ctx.job.messageId,
			utcDate: '2026-07-25',
			expiresAt: Date.now() - 1,
		};
		ctx.job.routingLease = {
			token: 'lease-1',
			destinationProvider: 'other',
			probe: false,
			ip: ctx.ip,
			warmingReservation: oldReservation,
		};
		ctx.job.routingReentryToken = 'reentry-token';
		ctx.job.routingReentry = {
			envelopeInput: { kind: 'campaign' },
			retryState: {
				attempt: 9,
				startedAt: Date.now(),
				idempotencyKey: ctx.job.messageId,
			},
		};
		vi.mocked(warming.ensureWarmingReservation).mockResolvedValueOnce({
			allowed: true,
			reservation: undefined,
		});

		const out = await warmingCapPhase.run(deps, ctx);

		expect(out.kind).toBe('continue');
		if (out.kind !== 'continue') return;
		expect(out.ctx.job.routingLease).not.toHaveProperty('warmingReservation');
		expect(warming.ensureWarmingReservation).toHaveBeenCalledWith(deps.redis, oldReservation);
		expect(warming.checkCap).not.toHaveBeenCalled();
	});

	/**
	 * P3-7's ONE sanctioned change on this path: a spent DAILY cap defers to the
	 * next cap window (bounded) instead of a blind 300 s, because the verdict
	 * cannot change until the day's counter resets and re-asking sooner is pure
	 * Redis churn. The regression proof is UPDATED to the new target rather than
	 * deleted — this path is still asserted, exactly as strictly.
	 */
	it('defers to the next cap window when the cap is reached', async () => {
		vi.mocked(warming.checkCap).mockResolvedValueOnce({
			allowed: false,
			sentToday: 100,
			dailyCap: 100,
		});
		const out = await warmingCapPhase.run(deps, makeCtx());
		expect(out).toEqual({
			kind: 'defer',
			delayMs: capDeferDelayMs(Date.now()),
			reason: expect.stringContaining('10.0.0.7'),
		});
		expect(out).not.toMatchObject({ delayMs: 300_000 });
	});

	/**
	 * D19: an attempt holding a live reservation already owns its per-IP slot.
	 * None of the three gates may take that slot back.
	 */
	it('never withholds an attempt that holds a live reservation', async () => {
		await redis.hset(warmingProviderStateKey(IP, 'microsoft'), {
			capMultiplier: '0.05',
			sentToday: '5000',
			sentTodayReset: UTC_DATE,
		});
		await redis.set(warmingBulkDailyKey(IP, UTC_DATE), '19000');
		const ctx = makeCtx({ pool: 'campaign', providerKey: 'microsoft' });
		const reservation = {
			ip: ctx.ip,
			messageId: ctx.job.messageId,
			utcDate: UTC_DATE,
			expiresAt: Date.now() + 60_000,
		};
		ctx.job.routingLease = {
			token: 'lease-2',
			destinationProvider: 'microsoft',
			probe: false,
			ip: ctx.ip,
			warmingReservation: reservation,
		};
		vi.mocked(warming.ensureWarmingReservation).mockResolvedValueOnce({
			allowed: true,
			reservation,
		});
		await recordProviderVolumePressure(
			redis,
			{ ip: IP, provider: 'microsoft', utcDate: UTC_DATE },
			PROVIDER_WARMING_POLICY.retryPressureWindowTtlSeconds
		);
		// Gates 2 and 3 are skipped by design here, so their inputs must not even
		// be read: two wasted keys and two extra chances to fail on the one path
		// the phase has already promised capacity to.
		const hmget = vi.spyOn(redis, 'hmget');

		const out = await warmingCapPhase.run(deps, ctx);

		expect(out.kind).toBe('continue');
		if (out.kind !== 'continue') return;
		expect(warming.checkCap).not.toHaveBeenCalled();
		expect(hmget).not.toHaveBeenCalled();
		// ...but the retry-backoff signal still reaches the outcome reducer.
		expect(out.ctx.providerVolumePressure).toBe(1);
		hmget.mockRestore();
	});

	describe('gate 2 — the per-(IP x mailbox provider) cap', () => {
		beforeEach(async () => {
			await redis.hset(warmingProviderStateKey(IP, 'microsoft'), {
				capMultiplier: '0.05',
				sentToday: '50',
				sentTodayReset: UTC_DATE,
			});
			vi.mocked(warming.checkCap).mockResolvedValue({
				allowed: true,
				sentToday: 60,
				dailyCap: 1000,
			});
		});

		it('defers at a narrowed provider while the per-IP cap still has room', async () => {
			const out = await warmingCapPhase.run(deps, makeCtx({ providerKey: 'microsoft' }));

			// The per-(IP x provider) cap is the same DAILY budget as the per-IP one,
			// so it earns the same deferral target (P3-7).
			expect(out).toEqual({
				kind: 'defer',
				delayMs: capDeferDelayMs(Date.now()),
				reason: expect.stringContaining('microsoft'),
			});
		});

		it('lets the same IP keep sending at an untouched provider', async () => {
			const out = await warmingCapPhase.run(deps, makeCtx({ providerKey: 'gmail' }));

			expect(out.kind).toBe('continue');
		});

		it('routes a governed attempt back to routing instead of deferring it', async () => {
			const ctx = makeCtx({ providerKey: 'microsoft' });
			ctx.job.routingReentryToken = 'reentry-token';

			const out = await warmingCapPhase.run(deps, ctx);

			expect(out.kind).toBe('routing_reentry');
		});
	});

	describe('gate 3 — intraday pacing', () => {
		it('defers a bulk burst that has already run ahead of the curve', async () => {
			vi.mocked(warming.checkCap).mockResolvedValue({
				allowed: true,
				sentToday: 5_000,
				dailyCap: 20_000,
			});
			await redis.set(warmingBulkDailyKey(IP, UTC_DATE), '5000');

			const out = await warmingCapPhase.run(deps, makeCtx({ pool: 'campaign' }));

			expect(out.kind).toBe('defer');
			if (out.kind !== 'defer') return;
			expect(out.delayMs).toBeGreaterThanOrEqual(INTRADAY_PACING_POLICY.minimumPacingRetryDelayMs);
			expect(out.delayMs).toBeLessThanOrEqual(INTRADAY_PACING_POLICY.maximumPacingRetryDelayMs);
			expect(out.reason).toContain('Intraday pacing');
		});

		it('does NOT stretch a small campaign on an IP that already sent transactional volume', async () => {
			// 120 transactional sends by 00:10 UTC against a 1000/day cap. The
			// per-IP counter says 120; the BULK counter says 0, and pacing must
			// read the bulk one — otherwise every one of these 50 sends defers.
			vi.mocked(warming.checkCap).mockResolvedValue({
				allowed: true,
				sentToday: 120,
				dailyCap: 1000,
			});
			for (let index = 0; index < 120; index += 1) {
				await recordProviderWarmingSend(
					redis,
					{ ip: IP, provider: 'gmail', utcDate: UTC_DATE },
					'transactional'
				);
			}
			expect(await redis.get(warmingBulkDailyKey(IP, UTC_DATE))).toBeNull();

			for (let recipient = 0; recipient < 50; recipient += 1) {
				const out = await warmingCapPhase.run(
					deps,
					makeCtx({ pool: 'campaign', providerKey: 'gmail' })
				);
				expect(out.kind).toBe('continue');
				await recordProviderWarmingSend(
					redis,
					{ ip: IP, provider: 'gmail', utcDate: UTC_DATE },
					'campaign'
				);
			}
			expect(await redis.get(warmingBulkDailyKey(IP, UTC_DATE))).toBe('50');
		});

		it('never paces transactional traffic, even at the end of a spent day', async () => {
			vi.setSystemTime(new Date(`${UTC_DATE}T23:59:00.000Z`));
			vi.mocked(warming.checkCap).mockResolvedValue({
				allowed: true,
				sentToday: 19_999,
				dailyCap: 20_000,
			});
			await redis.set(warmingBulkDailyKey(IP, UTC_DATE), '16000');

			const out = await warmingCapPhase.run(deps, makeCtx({ pool: 'transactional' }));

			expect(out.kind).toBe('continue');
		});
	});

	it('enriches the ctx with the recorded per-provider volume pressure', async () => {
		vi.mocked(warming.checkCap).mockResolvedValue({
			allowed: true,
			sentToday: 1,
			dailyCap: 1000,
		});
		await recordProviderVolumePressure(
			redis,
			{ ip: IP, provider: 'gmail', utcDate: UTC_DATE },
			PROVIDER_WARMING_POLICY.retryPressureWindowTtlSeconds
		);
		await recordProviderVolumePressure(
			redis,
			{ ip: IP, provider: 'gmail', utcDate: UTC_DATE },
			PROVIDER_WARMING_POLICY.retryPressureWindowTtlSeconds
		);

		const out = await warmingCapPhase.run(deps, makeCtx({ providerKey: 'gmail' }));

		expect(out.kind).toBe('continue');
		if (out.kind !== 'continue') return;
		expect(out.ctx.providerVolumePressure).toBe(2);
	});
});

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
const NOW_ISO = `${UTC_DATE}T14:00:00.000Z`;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** The blind delay the shipped phase used for a cap withholding. */
const SHIPPED_BLIND_DEFER_MS = 300_000;

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
	// Mid-afternoon: far enough from both boundaries that the delay is unambiguous.
	beforeEach(() => vi.setSystemTime(new Date(NOW_ISO)));

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
