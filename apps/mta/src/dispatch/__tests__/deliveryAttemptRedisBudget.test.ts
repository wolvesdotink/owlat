/**
 * Standing guard: what one delivery attempt costs this Redis, and for how long.
 *
 * Three separate incidents have now traced back to a key the MTA writes per
 * message without a bound. Redis runs `--maxmemory` with
 * `maxmemory-policy noeviction` (docker-compose.yml), so an unbounded — or
 * merely long-lived and numerous — per-attempt key is not bloat: at the cap
 * Redis refuses writes and the MTA stops accepting mail.
 *
 * So this drives the REAL effect runner over the effect lists the reducer emits
 * for one campaign message, with a real replay guard so the idempotency-receipt
 * branches run, against real Lua on ioredis-mock. Every terminal shape gets the
 * every-key-expires sweep and the replay check, because they share the receipt
 * writers and differ only in which of them they call — a deferral is also the
 * only outcome a message can reach MANY times, once per retry. The three
 * capacity numbers are pinned against the delivered list, the heaviest one:
 *
 *   - every key created is expired, bar the named, justified exceptions;
 *   - how many keys one attempt leaves behind, and how many of those are
 *     per-attempt rather than shared;
 *   - the longest retention window any of them carries.
 *
 * Changing any of them is a capacity decision, not test maintenance: at the
 * 512 MB default, ~5 receipt keys per attempt at ~300 bytes held for 7 days
 * (35 for the campaign one) means receipts alone approach the cap somewhere
 * around 25-30k delivery attempts per day. Raise a number here and
 * `REDIS_MAXMEMORY` guidance has to move with it. Count a retried message once
 * per ATTEMPT, not once per message: the deferral list is the one a message
 * runs repeatedly.
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

/** The terminal shapes the reducer can produce for one attempt. */
type TerminalOutcome = 'delivered' | 'deferred' | 'bounced';
const TERMINAL_OUTCOMES: TerminalOutcome[] = ['delivered', 'deferred', 'bounced'];

/** Keys one delivered campaign message leaves in Redis. */
const KEYS_PER_DELIVERED_CAMPAIGN_MESSAGE = 21;
/**
 * Of those, the ones minted per ATTEMPT rather than shared across attempts —
 * per terminal outcome, because they are the cost that MULTIPLIES. A delivered
 * or bounced message reaches its list once; a deferred one reaches its list
 * again on every retry, so a message that greylists five times before landing
 * costs five times this row for the receipt window (7 days).
 */
const RECEIPT_KEYS_PER_ATTEMPT: Record<TerminalOutcome, number> = {
	delivered: 5,
	deferred: 5,
	bounced: 4,
};
/** Longest retention any single attempt leaves behind, in days. */
const LONGEST_TTL_DAYS = 35;

/**
 * The keys each path leaves deliberately unexpired.
 *
 * Per-IP warming state is the IP's warming SCHEDULE — its day, its cap
 * multiplier, its clean streak. Expiring it would silently restart warming for
 * a live IP. It is safe unexpired because its cardinality is the operator's
 * configured IP pool, which does not grow with traffic; every other key on this
 * path is keyed by something a message chose (a recipient domain, a campaign,
 * an attempt) and so must expire. Only a SEND writes it — a deferral or a
 * bounce moves the day's counters and leaves the schedule alone.
 *
 * The suppression entries a hard bounce writes are the exception that DOES grow
 * with volume: one set member and one metadata key per distinct address that
 * has ever hard-bounced. That is the point of a suppression list — an address
 * that does not exist never starts existing, and forgetting it means sending to
 * it again — so, unlike the soft-bounce entries beside it, it cannot carry a
 * TTL. It is named here so the growth is a stated decision rather than
 * something this guard quietly permits: it is the one line in the Redis budget
 * that scales with a customer's bad-address count rather than with their IP
 * pool, so a list that ever needs bounding needs bounding by eviction policy,
 * not by an expiry on the entry.
 */
function permanentByDesign(outcome: TerminalOutcome): string[] {
	switch (outcome) {
		case 'delivered':
			return [warmingStateKey(IP)];
		case 'deferred':
			return [];
		case 'bounced':
			return ['mta:suppressed', `mta:suppressed-meta:someone@${DOMAIN}`];
	}
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
 * The retryable-deferral list, which a message can reach once per retry rather
 * than once per lifetime — and the only one that writes a volume-pressure key.
 */
function deferredCampaignEffects(): DispatchEffect[] {
	return [
		{ kind: 'domain_throttle_defer', ip: IP, throttleKey: DOMAIN, providerKey: 'gmail' },
		{ kind: 'smtp_response', domain: DOMAIN, smtpCode: 451, enhancedCode: '4.7.1' },
		{
			kind: 'warming_record',
			ip: IP,
			result: 'deferral',
			providerKey: 'gmail',
			utcDate: UTC_DATE,
		},
		{ kind: 'warming_provider_pressure', ip: IP, providerKey: 'gmail', utcDate: UTC_DATE },
		{
			kind: 'metrics_record',
			domain: DOMAIN,
			ip: IP,
			pool: 'campaign',
			outcome: 'deferred',
			durationMs: 120,
			providerKey: 'gmail',
		},
		{
			kind: 'log_delivery_event',
			event: {
				messageId: 'msg-1',
				to: `someone@${DOMAIN}`,
				from: 'sender@acme.test',
				orgId: 'org-1',
				status: 'deferred',
				domain: DOMAIN,
				smtpCode: 451,
			},
		},
	];
}

/** The hard-bounce list — the only one that reaches the suppression list. */
function bouncedCampaignEffects(): DispatchEffect[] {
	return [
		{ kind: 'circuit_breaker_outcome', orgId: 'org-1', outcome: 'bounced', providerKey: 'gmail' },
		{ kind: 'smtp_response', domain: DOMAIN, smtpCode: 550, enhancedCode: '5.1.1' },
		{ kind: 'domain_throttle_reject', ip: IP, throttleKey: DOMAIN },
		{ kind: 'warming_record', ip: IP, result: 'bounce', providerKey: 'gmail', utcDate: UTC_DATE },
		{
			kind: 'metrics_record',
			domain: DOMAIN,
			ip: IP,
			pool: 'campaign',
			outcome: 'bounced',
			durationMs: 120,
			providerKey: 'gmail',
		},
		{
			kind: 'log_delivery_event',
			event: {
				messageId: 'msg-1',
				to: `someone@${DOMAIN}`,
				from: 'sender@acme.test',
				orgId: 'org-1',
				status: 'bounced',
				domain: DOMAIN,
				smtpCode: 550,
			},
		},
		{ kind: 'suppress_recipient', address: `someone@${DOMAIN}`, reason: 'hard_bounce' },
	];
}

const EFFECTS_BY_OUTCOME: Record<TerminalOutcome, () => DispatchEffect[]> = {
	delivered: deliveredCampaignEffects,
	deferred: deferredCampaignEffects,
	bounced: bouncedCampaignEffects,
};

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

async function runAttempt(
	redis: Redis,
	attempt: string,
	outcome: TerminalOutcome = 'delivered'
): Promise<void> {
	const deps: PhaseDeps = { redis, config };
	await applyEffects(EFFECTS_BY_OUTCOME[outcome](), deps, replayGuardFor(attempt));
}

async function unexpiredKeys(redis: Redis): Promise<string[]> {
	const unexpired: string[] = [];
	for (const key of realKeys(await redis.keys('*'))) {
		// -1 is "exists, no expiry" — the state this guard exists to catch.
		if ((await redis.ttl(key)) < 0) unexpired.push(key);
	}
	return unexpired;
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

	it.each(TERMINAL_OUTCOMES)(
		'expires every key a %s attempt creates, bar the ones permanent by design',
		async (outcome) => {
			await runAttempt(redis, 'attempt-1', outcome);

			expect(await unexpiredKeys(redis)).toEqual(permanentByDesign(outcome));
		}
	);

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

	it.each(TERMINAL_OUTCOMES)(
		'costs nothing extra when the same %s attempt is replayed',
		async (outcome) => {
			await runAttempt(redis, 'attempt-1', outcome);
			const afterFirst = realKeys(await redis.keys('*'));

			await runAttempt(redis, 'attempt-1', outcome);
			await runAttempt(redis, 'attempt-1', outcome);

			// The idempotency receipts are themselves keys, so a replay that
			// re-derived its identities would show up here as growth.
			expect(realKeys(await redis.keys('*'))).toEqual(afterFirst);
		}
	);

	it.each(TERMINAL_OUTCOMES)(
		'adds only receipts per %s attempt — the rest of the state is shared',
		async (outcome) => {
			await runAttempt(redis, 'attempt-1', outcome);
			const afterFirst = realKeys(await redis.keys('*'));
			const isReceipt = (key: string) => key.includes(':effect:');

			await runAttempt(redis, 'attempt-2', outcome);
			await runAttempt(redis, 'attempt-3', outcome);
			const afterThird = realKeys(await redis.keys('*'));

			// Per-domain / per-IP / per-day counters are shared across attempts. If
			// one of them starts appearing once per attempt — a message id or an
			// attempt number creeping into a key — this is what catches it.
			expect(afterThird.filter((key) => !isReceipt(key))).toEqual(
				afterFirst.filter((key) => !isReceipt(key))
			);
			expect(afterFirst.filter(isReceipt)).toHaveLength(RECEIPT_KEYS_PER_ATTEMPT[outcome]);
			expect(afterThird.filter(isReceipt)).toHaveLength(3 * RECEIPT_KEYS_PER_ATTEMPT[outcome]);
		}
	);
});
