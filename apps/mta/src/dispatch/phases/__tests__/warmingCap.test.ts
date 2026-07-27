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
import { INTRADAY_PACING_POLICY } from '../../../intelligence/warmingPacing.js';
import type { DestinationProviderKey, EmailJob, IpPoolType } from '../../../types.js';
import type { MtaConfig } from '../../../config.js';

const IP = '10.0.0.7';
const UTC_DATE = '2026-07-27';

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

	it('defers 5 minutes when the cap is reached', async () => {
		vi.mocked(warming.checkCap).mockResolvedValueOnce({
			allowed: false,
			sentToday: 100,
			dailyCap: 100,
		});
		const out = await warmingCapPhase.run(deps, makeCtx());
		expect(out).toEqual({
			kind: 'defer',
			delayMs: 300_000,
			reason: expect.stringContaining('10.0.0.7'),
		});
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

		const out = await warmingCapPhase.run(deps, ctx);

		expect(out.kind).toBe('continue');
		expect(warming.checkCap).not.toHaveBeenCalled();
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

			expect(out).toEqual({
				kind: 'defer',
				delayMs: 300_000,
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
			PROVIDER_WARMING_POLICY.pressureTtlSeconds
		);
		await recordProviderVolumePressure(
			redis,
			{ ip: IP, provider: 'gmail', utcDate: UTC_DATE },
			PROVIDER_WARMING_POLICY.pressureTtlSeconds
		);

		const out = await warmingCapPhase.run(deps, makeCtx({ providerKey: 'gmail' }));

		expect(out.kind).toBe('continue');
		if (out.kind !== 'continue') return;
		expect(out.ctx.providerVolumePressure).toBe(2);
	});
});
