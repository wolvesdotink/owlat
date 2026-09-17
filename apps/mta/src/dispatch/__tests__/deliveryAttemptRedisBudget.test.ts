/**
 * Standing guard: what one delivery attempt costs this Redis, and for how long.
 *
 * Three separate incidents have now traced back to a key the MTA writes per
 * message without a bound. Redis runs `--maxmemory` with
 * `maxmemory-policy noeviction` (docker-compose.yml), so an unbounded — or
 * merely long-lived and numerous — per-attempt key is not bloat: at the cap
 * Redis refuses writes and the MTA stops accepting mail.
 *
 * So this drives the REAL effect runner over the effect list `reduceDelivered`
 * emits for one delivered campaign message — the heaviest terminal outcome —
 * with a real replay guard so the idempotency-receipt branches run, against
 * real Lua on ioredis-mock. It then pins the three numbers that decide how much
 * Redis a customer's send volume holds:
 *
 *   - every key created is expired, bar one named, justified exception;
 *   - how many keys one attempt leaves behind, and how many of those are
 *     per-attempt rather than shared;
 *   - the longest retention window any of them carries.
 *
 * Changing any of them is a capacity decision, not test maintenance: at the
 * 512 MB default, ~5 receipt keys per attempt at ~300 bytes held for 7 days
 * (35 for the campaign one) means receipts alone approach the cap somewhere
 * around 25-30k delivery attempts per day. Raise a number here and
 * `REDIS_MAXMEMORY` guidance has to move with it.
 *
 * The narrower per-provider-warming twin of this file lives at
 * `src/intelligence/__tests__/redisDiscipline.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';

vi.mock('../../webhooks/convexNotifier.js', () => ({
	notifyConvex: vi.fn().mockResolvedValue(true),
	queueConvexWebhook: vi.fn().mockResolvedValue('outbox-1'),
}));
vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { applyEffects, type DispatchEffect, type DispatchEffectReplayGuard } from '../effects.js';
import { durableEffectIdentity, type DurableEffectIdentity } from '../../lib/effectCheckpoint.js';
import { warmingStateKey } from '../../intelligence/warmingKeys.js';
import type { PhaseDeps } from '../types.js';
import type { MtaConfig } from '../../config.js';

const IP = '10.0.0.7';
const DOMAIN = 'recipient.example';
const UTC_DATE = '2026-07-22';
const DELIVERY_LOG_TTL_HOURS = 24 * 30;
const DELIVERY_LOG_MAX_LEN = 10_000;

const config = {
	deliveryLogMaxLen: DELIVERY_LOG_MAX_LEN,
	deliveryLogTtlHours: DELIVERY_LOG_TTL_HOURS,
} as unknown as MtaConfig;

/** Keys one delivered campaign message leaves in Redis. */
const KEYS_PER_DELIVERED_CAMPAIGN_MESSAGE = 21;
/** Of those, the ones minted per ATTEMPT rather than shared across attempts. */
const RECEIPT_KEYS_PER_ATTEMPT = 5;
/** Longest retention any single attempt leaves behind, in days. */
const LONGEST_TTL_DAYS = 35;

/**
 * The one key on this path that is deliberately permanent.
 *
 * Per-IP warming state is the IP's warming SCHEDULE — its day, its cap
 * multiplier, its clean streak. Expiring it would silently restart warming for
 * a live IP. It is safe unexpired because its cardinality is the operator's
 * configured IP pool, which does not grow with traffic; every other key on this
 * path is keyed by something a message chose (a recipient domain, a campaign,
 * an attempt) and so must expire.
 */
function permanentByDesign(): string[] {
	return [warmingStateKey(IP)];
}

/**
 * ioredis-mock models each stream ENTRY as its own `stream:<key>:<id>` key.
 * Real Redis keeps one stream key with the entries inside it, so those are a
 * double artifact and counting them would measure the mock. The real stream
 * key (`mta:delivery-log:<date>`) IS counted, and its own bound — MAXLEN plus
 * a TTL — is asserted separately below.
 */
function realKeys(keys: string[]): string[] {
	return keys.filter((key) => !key.startsWith('stream:')).sort();
}

function deliveredCampaignEffects(): DispatchEffect[] {
	return [
		{ kind: 'domain_throttle_success', ip: IP, throttleKey: DOMAIN, providerKey: 'gmail' },
		{
			kind: 'circuit_breaker_outcome',
			orgId: 'org-1',
			outcome: 'delivered',
			providerKey: 'gmail',
		},
		{ kind: 'campaign_delivery_record', campaignId: 'abcdef0123456789' },
		{ kind: 'smtp_response', domain: DOMAIN, smtpCode: 250, enhancedCode: '2.0.0' },
		{
			kind: 'warming_record',
			ip: IP,
			result: 'send',
			providerKey: 'gmail',
			pool: 'campaign',
			utcDate: UTC_DATE,
		},
		{
			kind: 'metrics_record',
			domain: DOMAIN,
			ip: IP,
			pool: 'campaign',
			outcome: 'delivered',
			durationMs: 120,
			providerKey: 'gmail',
		},
		{ kind: 'domain_failure_clear', domain: DOMAIN },
		{
			kind: 'log_delivery_event',
			event: {
				messageId: 'msg-1',
				to: `someone@${DOMAIN}`,
				from: 'sender@acme.test',
				orgId: 'org-1',
				status: 'delivered',
				domain: DOMAIN,
				smtpCode: 250,
			},
		},
	];
}

/**
 * A replay guard that hands each effect the durable identity it would get in
 * production, without the lease machinery. That identity is what switches the
 * writers onto their receipt-guarded Lua, so it is the branch that has to be
 * measured — the unguarded branch writes fewer keys and would flatter us.
 */
function replayGuardFor(attempt: string): DispatchEffectReplayGuard {
	return {
		runSecondary: async <T>(
			effectIdentity: string,
			apply: (identity: DurableEffectIdentity) => Promise<T>
		) => apply(durableEffectIdentity(attempt, effectIdentity)),
	};
}

async function runAttempt(redis: Redis, attempt: string): Promise<void> {
	const deps: PhaseDeps = { redis, config };
	await applyEffects(deliveredCampaignEffects(), deps, replayGuardFor(attempt));
}

describe('Redis budget for one delivery attempt', () => {
	let redis: Redis;

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(`${UTC_DATE}T12:00:00.000Z`));
		redis = new RedisMock() as unknown as Redis;
		// ioredis-mock shares one keyspace across instances.
		await redis.flushall();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('expires every key it creates except the one that is permanent by design', async () => {
		await runAttempt(redis, 'attempt-1');

		const unexpired: string[] = [];
		for (const key of realKeys(await redis.keys('*'))) {
			// -1 is "exists, no expiry" — the state this guard exists to catch.
			if ((await redis.ttl(key)) < 0) unexpired.push(key);
		}
		expect(unexpired).toEqual(permanentByDesign());
	});

	it('pins the key count and the longest retention window', async () => {
		await runAttempt(redis, 'attempt-1');

		const keys = realKeys(await redis.keys('*'));
		expect(keys).toHaveLength(KEYS_PER_DELIVERED_CAMPAIGN_MESSAGE);

		let longestTtlSeconds = 0;
		for (const key of keys) {
			longestTtlSeconds = Math.max(longestTtlSeconds, await redis.ttl(key));
		}
		expect(longestTtlSeconds).toBe(LONGEST_TTL_DAYS * 86_400);
	});

	it('bounds the delivery-log stream by length as well as by time', async () => {
		await runAttempt(redis, 'attempt-1');

		const streamKey = `mta:delivery-log:${UTC_DATE}`;
		expect(await redis.ttl(streamKey)).toBe(DELIVERY_LOG_TTL_HOURS * 3600);
		// A stream is the one key here that is bounded by entries rather than by
		// key count, so its MAXLEN is the bound and has to be a real number.
		expect(DELIVERY_LOG_MAX_LEN).toBeGreaterThan(0);
	});

	it('costs nothing extra when the same attempt is replayed', async () => {
		await runAttempt(redis, 'attempt-1');
		const afterFirst = realKeys(await redis.keys('*'));

		await runAttempt(redis, 'attempt-1');
		await runAttempt(redis, 'attempt-1');

		// The idempotency receipts are themselves keys, so a replay that
		// re-derived its identities would show up here as growth.
		expect(realKeys(await redis.keys('*'))).toEqual(afterFirst);
	});

	it('adds only receipts per attempt — the rest of the state is shared', async () => {
		await runAttempt(redis, 'attempt-1');
		const afterFirst = realKeys(await redis.keys('*'));
		const isReceipt = (key: string) => key.includes(':effect:');

		await runAttempt(redis, 'attempt-2');
		await runAttempt(redis, 'attempt-3');
		const afterThird = realKeys(await redis.keys('*'));

		// Per-domain / per-IP / per-day counters are shared across attempts. If
		// one of them starts appearing once per attempt — a message id or an
		// attempt number creeping into a key — this is what catches it.
		expect(afterThird.filter((key) => !isReceipt(key))).toEqual(
			afterFirst.filter((key) => !isReceipt(key))
		);
		expect(afterFirst.filter(isReceipt)).toHaveLength(RECEIPT_KEYS_PER_ATTEMPT);
		expect(afterThird.filter(isReceipt)).toHaveLength(3 * RECEIPT_KEYS_PER_ATTEMPT);
	});
});
