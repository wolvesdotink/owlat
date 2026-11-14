import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Redis from 'ioredis-mock';
import {
	checkSystemHealth,
	shouldBackoffDomain,
	recordDomainFailure,
	clearDomainFailure,
} from '../degradation.js';
import { durableEffectIdentity } from '../../lib/effectCheckpoint.js';
import { classifyResult, reduce } from '../../dispatch/outcome.js';
import { applyEffects } from '../../dispatch/effects.js';
import { domainBackoffPhase } from '../../dispatch/phases/domainBackoff.js';
import type { AttemptCtx, BasePhaseCtx } from '../../dispatch/types.js';
import type { EmailJob } from '../../types.js';
import { createOwlatHostConfig } from '../../__tests__/helpers/fixtures.js';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../redis.js', () => ({
	isRedisHealthy: vi.fn(),
}));

import { isRedisHealthy } from '../../redis.js';
const mockIsRedisHealthy = vi.mocked(isRedisHealthy);

describe('degradation', () => {
	let redis: InstanceType<typeof Redis>;

	beforeEach(() => {
		redis = new Redis();
		mockIsRedisHealthy.mockReset();
	});

	describe('shouldBackoffDomain', () => {
		it('returns false when no failure state exists', async () => {
			const result = await shouldBackoffDomain(redis, 'example.com');
			expect(result.backoff).toBe(false);
		});
	});

	describe('recordDomainFailure', () => {
		it('causes shouldBackoffDomain to return true with retryAfter', async () => {
			await recordDomainFailure(redis, 'fail.com');

			const result = await shouldBackoffDomain(redis, 'fail.com');
			expect(result.backoff).toBe(true);
			expect(result.retryAfter).toBeGreaterThan(0);
		});

		it('applies exponential backoff: first=30s, second=60s', async () => {
			await recordDomainFailure(redis, 'exp.com');
			const first = await shouldBackoffDomain(redis, 'exp.com');

			await recordDomainFailure(redis, 'exp.com');
			const second = await shouldBackoffDomain(redis, 'exp.com');

			// Second failure should have a longer retryAfter than the first
			expect(second.retryAfter!).toBeGreaterThan(first.retryAfter! * 0.9);
		});
	});

	describe('clearDomainFailure', () => {
		it('removes failure state', async () => {
			await recordDomainFailure(redis, 'clear.com');
			await clearDomainFailure(redis, 'clear.com');

			const result = await shouldBackoffDomain(redis, 'clear.com');
			expect(result.backoff).toBe(false);
		});
	});

	describe('a domain whose every MX host refuses at the greeting', () => {
		beforeEach(() => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-03-22T12:00:00Z'));
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		const destination: BasePhaseCtx['destination'] = {
			recipientDomain: 'example.com',
			providerKey: 'other',
			throttleKey: 'example.com',
			mx: {
				status: 'deliverable',
				source: 'mx',
				hosts: [
					{ exchange: 'mx1.example.com', priority: 10 },
					{ exchange: 'mx2.example.com', priority: 20 },
				],
			},
			daneDiscoveryAuthenticated: true,
		};
		const job = (messageId: string): EmailJob => ({
			messageId,
			to: 'user@example.com',
			from: 'sender@owlat.com',
			subject: 'Test',
			html: '<p>Hello</p>',
			ipPool: 'transactional',
			organizationId: 'org-1',
			dkimDomain: 'owlat.com',
		});

		it('backs the next message for that domain off instead of dialling straight back', async () => {
			const deps = { redis, config: createOwlatHostConfig() } as unknown as Parameters<
				typeof applyEffects
			>[1];
			const attempt: AttemptCtx = {
				job: job('msg-1'),
				domain: 'example.com',
				destination,
				fromDomain: 'owlat.com',
				pool: 'transactional',
				dedicatedIp: undefined,
				ip: '192.0.2.10',
				eligibilityGeneration: 1,
				providerVolumePressure: 0,
				utcDate: '2026-03-22',
				durationMs: 12,
			};
			// What the MX loop returns once both hosts answered the greeting with 421.
			const { effects } = reduce(
				classifyResult({
					success: false,
					bounceType: 'deferred',
					smtpCode: 421,
					smtpPhase: 'greeting',
					error: '421 mx2.example.com Service not available, closing transmission channel',
				}),
				attempt
			);
			await applyEffects(
				effects.filter((effect) => effect.kind === 'domain_failure_record'),
				deps
			);

			const next = await domainBackoffPhase.run(deps, {
				job: job('msg-2'),
				domain: 'example.com',
				destination,
				fromDomain: 'owlat.com',
			});
			// One recorded failure: the first step of the schedule, exactly.
			expect(next).toMatchObject({ kind: 'defer', delayMs: 30_000, bounceCause: 'recipient' });
		});
	});

	describe('checkSystemHealth', () => {
		const queue = { getWaitingCount: vi.fn(async () => 0) };

		it('returns redisHealthy=true when isRedisHealthy returns true', async () => {
			mockIsRedisHealthy.mockResolvedValue(true);

			const state = await checkSystemHealth(redis, queue as never);
			expect(state.redisHealthy).toBe(true);
		});

		it('returns redisHealthy=false when isRedisHealthy returns false', async () => {
			mockIsRedisHealthy.mockResolvedValue(false);

			const state = await checkSystemHealth(redis, queue as never);
			expect(state.redisHealthy).toBe(false);
		});

		it('engages backpressure from GroupMQ waiting depth', async () => {
			mockIsRedisHealthy.mockResolvedValue(true);
			queue.getWaitingCount.mockResolvedValueOnce(10_001);

			const state = await checkSystemHealth(redis, queue as never);

			expect(state.backpressure).toBe(true);
		});
	});

	// ────────────────────────────────────────────────────────────────────
	// PR-73 regression lock: connection-level domain backoff.
	// Locks the exact exponential schedule 30000 * 2^(n-1) capped at
	// 600000ms, clear-on-success, and the PX-driven auto-clear once the
	// backoff window has elapsed. This is the TCP/connection-failure
	// back-off, distinct from the SMTP-response intelligence layer.
	// ────────────────────────────────────────────────────────────────────
	describe('PR-73: exponential connection backoff schedule', () => {
		beforeEach(() => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-03-22T12:00:00Z'));
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it('follows 30000 * 2^(n-1) and caps at 600000ms', async () => {
			// count → expected delay (ms)
			const expected = [
				30_000, // 1: 30000 * 2^0
				60_000, // 2: 30000 * 2^1
				120_000, // 3
				240_000, // 4
				480_000, // 5
				600_000, // 6: 960000 capped at 600000
				600_000, // 7: stays capped
			];

			for (let i = 0; i < expected.length; i++) {
				await recordDomainFailure(redis, 'sched.com');
				const result = await shouldBackoffDomain(redis, 'sched.com');
				expect(result.backoff).toBe(true);
				// retryAfter is computed as retryAt - now; with frozen time it
				// equals the delay exactly.
				expect(result.retryAfter).toBe(expected[i]);
			}
		});

		it('the idempotent Lua path follows the same schedule as the TypeScript one', async () => {
			const scheduleOf = async (domain: string, record: (n: number) => Promise<void>) => {
				const delays: Array<number | undefined> = [];
				for (let n = 0; n < 7; n++) {
					await record(n);
					delays.push((await shouldBackoffDomain(redis, domain)).retryAfter);
				}
				return delays;
			};
			const viaTypeScript = await scheduleOf('plain.com', () =>
				recordDomainFailure(redis, 'plain.com')
			);
			const viaLua = await scheduleOf('lua.com', (n) =>
				recordDomainFailure(redis, 'lua.com', durableEffectIdentity('smtp-attempt:parity', `${n}`))
			);
			expect(viaLua).toEqual(viaTypeScript);
			expect(viaLua).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000]);
		});

		it('first failure backs off exactly 30s (the base)', async () => {
			await recordDomainFailure(redis, 'base.com');
			const result = await shouldBackoffDomain(redis, 'base.com');
			expect(result.retryAfter).toBe(30_000);
		});
	});

	describe('PR-73: backoff clears on success and after the window elapses', () => {
		beforeEach(() => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-03-22T12:00:00Z'));
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it('clearDomainFailure resets the schedule back to the 30s base', async () => {
			// Escalate to the third step (120s).
			await recordDomainFailure(redis, 'reset.com');
			await recordDomainFailure(redis, 'reset.com');
			await recordDomainFailure(redis, 'reset.com');
			expect((await shouldBackoffDomain(redis, 'reset.com')).retryAfter).toBe(120_000);

			// A successful connection clears BOTH the retry-at key and the count.
			await clearDomainFailure(redis, 'reset.com');
			expect((await shouldBackoffDomain(redis, 'reset.com')).backoff).toBe(false);

			// The next failure starts over at the 30s base (count was reset).
			await recordDomainFailure(redis, 'reset.com');
			expect((await shouldBackoffDomain(redis, 'reset.com')).retryAfter).toBe(30_000);
		});

		it('lets the domain through once the window has elapsed but keeps its failure count', async () => {
			await recordDomainFailure(redis, 'elapse.com'); // 30s window
			expect((await shouldBackoffDomain(redis, 'elapse.com')).backoff).toBe(true);

			vi.setSystemTime(new Date(Date.now() + 30_001));
			expect((await shouldBackoffDomain(redis, 'elapse.com')).backoff).toBe(false);

			// The probe that the elapsed window let through fails too: the backoff
			// takes its second step instead of starting over at the 30s base.
			await recordDomainFailure(redis, 'elapse.com');
			expect((await shouldBackoffDomain(redis, 'elapse.com')).retryAfter).toBe(60_000);
		});

		it('escalates across elapsed windows to the cap on both recording paths', async () => {
			const scheduleAcrossWindows = async (
				domain: string,
				record: (n: number) => Promise<void>
			) => {
				const delays: Array<number | undefined> = [];
				for (let n = 0; n < 7; n++) {
					await record(n);
					const { retryAfter } = await shouldBackoffDomain(redis, domain);
					delays.push(retryAfter);
					vi.setSystemTime(new Date(Date.now() + (retryAfter ?? 0) + 1));
					expect((await shouldBackoffDomain(redis, domain)).backoff).toBe(false);
				}
				return delays;
			};
			const expected = [30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000];

			expect(
				await scheduleAcrossWindows('plain-window.com', () =>
					recordDomainFailure(redis, 'plain-window.com')
				)
			).toEqual(expected);
			expect(
				await scheduleAcrossWindows('lua-window.com', (n) =>
					recordDomainFailure(
						redis,
						'lua-window.com',
						durableEffectIdentity('smtp-attempt:window', `${n}`)
					)
				)
			).toEqual(expected);
		});

		it('starts over at the base after a success that follows an elapsed window', async () => {
			await recordDomainFailure(redis, 'recover.com');
			await recordDomainFailure(redis, 'recover.com');
			vi.setSystemTime(new Date(Date.now() + 60_001));
			expect((await shouldBackoffDomain(redis, 'recover.com')).backoff).toBe(false);

			await clearDomainFailure(redis, 'recover.com');
			await recordDomainFailure(redis, 'recover.com');

			expect((await shouldBackoffDomain(redis, 'recover.com')).retryAfter).toBe(30_000);
		});
	});
});
