/**
 * The warming day an attempt books into is the day its cap gates measured.
 *
 * Effects are journalled beside the irreversible SMTP result and applied
 * afterwards — possibly minutes later, possibly by a different worker after a
 * crash. Re-reading the clock at apply time therefore books a midnight-
 * straddling attempt, and every replay of it, into a day that never admitted
 * it, which skews the completed-previous-day evaluation window the per-provider
 * ramp reads.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type RealRedis from 'ioredis';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { applyEffects, type DispatchEffect } from '../effects.js';
import { reduce, type DispatchOutcome, type OutcomeReduction } from '../outcome.js';
import { warmingCapPhase } from '../phases/warmingCap.js';
import type { AttemptCtx, CtxWithIp, PhaseDeps } from '../types.js';
import { initializeWarming } from '../../intelligence/warming.js';
import { classifySmtpResponse } from '../../intelligence/smtpClassifier.js';
import {
	warmingBulkDailyKey,
	warmingProviderDailyStatsKey,
	warmingProviderStateKey,
} from '../../intelligence/warmingKeys.js';
import { createTestConfig } from '../../__tests__/helpers/fixtures.js';
import type { EmailJob } from '../../types.js';

const IP = '10.0.0.21';
const GATED_AT = '2026-03-01T23:59:30.000Z';
const APPLIED_AT = '2026-03-02T00:00:30.000Z';
const GATED_DAY = '2026-03-01';
const APPLIED_DAY = '2026-03-02';

function job(): EmailJob {
	return {
		messageId: 'msg-midnight-1',
		to: 'user@gmail.com',
		from: 'sender@owlat.com',
		subject: 'Test',
		html: '<p>Hello</p>',
		ipPool: 'campaign',
		organizationId: 'org-1',
		dkimDomain: 'owlat.com',
	};
}

function ctxWithIp(): CtxWithIp {
	return {
		job: job(),
		domain: 'gmail.com',
		destination: {
			recipientDomain: 'gmail.com',
			providerKey: 'gmail',
			throttleKey: 'gmail.com',
			mx: {
				status: 'deliverable',
				source: 'mx',
				hosts: [{ exchange: 'gmail-smtp-in.l.google.com', priority: 5 }],
			},
			daneDiscoveryAuthenticated: false,
		},
		fromDomain: 'owlat.com',
		pool: 'campaign',
		dedicatedIp: undefined,
		ip: IP,
		eligibilityGeneration: 1,
	};
}

const deliveredOutcome: DispatchOutcome = {
	kind: 'delivered',
	smtpCode: 250,
	smtpResponse: 'Queued',
	remoteMessageId: '<remote@gmail>',
	enhancedCode: '2.0.0',
};

const pressureDeferral: DispatchOutcome = {
	kind: 'deferred',
	smtpCode: 421,
	error:
		'421-4.7.28 Gmail has detected an unusual rate of unsolicited mail originating from your IP address.',
	enhancedCode: '4.7.28',
	classification: classifySmtpResponse(
		421,
		'421-4.7.28 Gmail has detected an unusual rate of unsolicited mail originating from your IP address.',
		'4.7.28',
		'gmail'
	),
};

describe('warming records book into the attempt day, not the apply day', () => {
	let redis: RealRedis;
	let deps: PhaseDeps;

	beforeEach(async () => {
		redis = new Redis() as unknown as RealRedis;
		// ioredis-mock shares one keyspace across instances.
		await redis.flushall();
		deps = { redis, config: createTestConfig() };
		vi.useFakeTimers();
		vi.setSystemTime(new Date(GATED_AT));
		await initializeWarming(redis, IP);
	});

	afterEach(() => vi.useRealTimers());

	/** Gate an attempt at 23:59:30 and reduce its outcome, as a worker would. */
	async function gateAndReduce(outcome: DispatchOutcome): Promise<OutcomeReduction> {
		const gated = await warmingCapPhase.run(deps, ctxWithIp());
		expect(gated.kind).toBe('continue');
		if (gated.kind !== 'continue') throw new Error('warming cap withheld the attempt');
		expect(gated.ctx.utcDate).toBe(GATED_DAY);
		const attempt: AttemptCtx = { ...gated.ctx, durationMs: 12 };
		return reduce(outcome, attempt);
	}

	/**
	 * Apply the warming effects the way a crashed worker's successor does: from
	 * the JSON the journal round-tripped, after the UTC day has rolled over.
	 */
	async function replayWarmingEffects(reduction: OutcomeReduction): Promise<void> {
		const journalled = JSON.parse(JSON.stringify(reduction)) as OutcomeReduction;
		vi.setSystemTime(new Date(APPLIED_AT));
		const warmingEffects = journalled.effects.filter(
			(effect: DispatchEffect) =>
				effect.kind === 'warming_record' || effect.kind === 'warming_provider_pressure'
		);
		expect(warmingEffects.length).toBeGreaterThan(0);
		await applyEffects(warmingEffects, deps);
	}

	it('counts a delivered send against the day that admitted it', async () => {
		const reduction = await gateAndReduce(deliveredOutcome);

		await replayWarmingEffects(reduction);

		expect(await redis.hget(warmingProviderDailyStatsKey(IP, 'gmail', GATED_DAY), 'sent')).toBe(
			'1'
		);
		expect(await redis.exists(warmingProviderDailyStatsKey(IP, 'gmail', APPLIED_DAY))).toBe(0);
		// The bulk pacing denominator is keyed by day too: pacing the new day
		// against yesterday's sends would throttle the first campaign of the day.
		expect(await redis.get(warmingBulkDailyKey(IP, GATED_DAY))).toBe('1');
		expect(await redis.get(warmingBulkDailyKey(IP, APPLIED_DAY))).toBeNull();
		// The per-provider counter rolls on its own stored day, so the stamped day
		// must be what the state records — otherwise the next attempt reads the
		// counter as belonging to a finished day and starts the cap over.
		expect(await redis.hget(warmingProviderStateKey(IP, 'gmail'), 'sentTodayReset')).toBe(
			GATED_DAY
		);
	});

	it('counts a pressure deferral and its volume-pressure verdict against the same day', async () => {
		const reduction = await gateAndReduce(pressureDeferral);

		await replayWarmingEffects(reduction);

		const stats = warmingProviderDailyStatsKey(IP, 'gmail', GATED_DAY);
		expect(await redis.hget(stats, 'deferred')).toBe('1');
		expect(await redis.hget(stats, 'pressure')).toBe('1');
		expect(await redis.exists(warmingProviderDailyStatsKey(IP, 'gmail', APPLIED_DAY))).toBe(0);
	});
});
