import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import { durableEffectIdentity } from '../../lib/effectCheckpoint.js';
import {
	recordDefer,
	recordReject,
	recordSuccess,
	throttleStateKey,
} from '../../intelligence/domainThrottle.js';
import { recordResponse, getDomainHealth, shouldDefer } from '../../intelligence/smtpResponse.js';
import { recordBounce, recordDeferral, recordSend } from '../../intelligence/warming.js';
import { recordDomainFailure, shouldBackoffDomain } from '../../scaling/degradation.js';
import { applyEffects as applyBounceEffects, fblStatsKey } from '../../bounce/effects.js';
import type { MtaConfig } from '../../config.js';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('replay-sensitive dispatch controls', () => {
	let redis: Redis;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-07-22T12:00:00.000Z'));
		redis = new RedisMock() as unknown as Redis;
	});

	afterEach(async () => {
		vi.useRealTimers();
		await redis.flushall();
	});

	it('does not apply a domain-throttle deferral twice after a committed response is lost', async () => {
		const identity = durableEffectIdentity('smtp-attempt:throttle', '0:domain_throttle_defer');
		loseFirstEvalResponse(redis, "local recentDefers = tonumber(redis.call('HGET'");

		await expect(recordDefer(redis, '10.0.0.1', 'gmail.com', 'gmail', identity)).rejects.toThrow(
			'lost Redis response'
		);
		await recordDefer(redis, '10.0.0.1', 'gmail.com', 'gmail', identity);

		expect(await redis.hget(throttleStateKey('10.0.0.1', 'gmail.com'), 'recentDefers')).toBe('1');
	});

	it('does not apply domain-throttle success or reject twice after response loss', async () => {
		const success = durableEffectIdentity('smtp-attempt:throttle', 'success');
		loseFirstEvalResponse(redis, "redis.call('HINCRBY', KEYS[1], 'consecutiveSuccess', 1)");
		await expect(recordSuccess(redis, '10.0.0.2', 'gmail.com', 'gmail', success)).rejects.toThrow(
			'lost Redis response'
		);
		await recordSuccess(redis, '10.0.0.2', 'gmail.com', 'gmail', success);
		expect(await redis.hget(throttleStateKey('10.0.0.2', 'gmail.com'), 'consecutiveSuccess')).toBe(
			'1'
		);

		const reject = durableEffectIdentity('smtp-attempt:throttle', 'reject');
		await redis.hset(throttleStateKey('10.0.0.3', 'gmail.com'), 'consecutiveSuccess', '5');
		loseFirstEvalResponse(redis, "redis.call('HSET', KEYS[1], 'consecutiveSuccess', '0')");
		await expect(recordReject(redis, '10.0.0.3', 'gmail.com', reject)).rejects.toThrow(
			'lost Redis response'
		);
		await recordReject(redis, '10.0.0.3', 'gmail.com', reject);
		expect(await redis.hget(throttleStateKey('10.0.0.3', 'gmail.com'), 'consecutiveSuccess')).toBe(
			'0'
		);
	});

	it('does not append or count an SMTP response twice after response loss', async () => {
		const identity = durableEffectIdentity('smtp-attempt:intel', '1:smtp_response');
		loseFirstEvalResponse(redis, "redis.call('LPUSH', KEYS[2]");

		await expect(recordResponse(redis, 'gmail.com', 421, '4.7.0', identity)).rejects.toThrow(
			'lost Redis response'
		);
		await recordResponse(redis, 'gmail.com', 421, '4.7.0', identity);

		expect(await getDomainHealth(redis, 'gmail.com')).toMatchObject({ totalSent: 1, total4xx: 1 });
	});

	it('reconstructs the original SMTP deferral deadline instead of extending it on replay', async () => {
		for (let response = 0; response < 4; response++) {
			await recordResponse(redis, 'slow.example', 421, '4.7.0');
		}
		const identity = durableEffectIdentity('smtp-attempt:intel', 'deadline');
		loseFirstEvalResponse(redis, "redis.call('LPUSH', KEYS[2]");
		await expect(recordResponse(redis, 'slow.example', 421, '4.7.0', identity)).rejects.toThrow(
			'lost Redis response'
		);

		vi.advanceTimersByTime(60_000);
		await recordResponse(redis, 'slow.example', 421, '4.7.0', identity);

		expect(await shouldDefer(redis, 'slow.example')).toBe(60_000);
	});

	it('does not count a warming bounce twice after response loss', async () => {
		const identity = durableEffectIdentity('smtp-attempt:warming', '2:warming_record');
		loseFirstEvalResponse(redis, "redis.call('HINCRBY', KEYS[1], ARGV[1], 1)");

		await expect(recordBounce(redis, '192.0.2.10', identity)).rejects.toThrow(
			'lost Redis response'
		);
		await recordBounce(redis, '192.0.2.10', identity);

		expect(await redis.hget('mta:warming:{warming:192.0.2.10}:daily:2026-07-22', 'bounced')).toBe(
			'1'
		);
	});

	it('does not count warming sends or deferrals twice after response loss', async () => {
		const send = durableEffectIdentity('smtp-attempt:warming', 'send');
		loseFirstEvalResponse(redis, "redis.call('HINCRBY', KEYS[1], 'sentToday', 1)");
		await expect(recordSend(redis, '192.0.2.11', undefined, send)).rejects.toThrow(
			'lost Redis response'
		);
		await recordSend(redis, '192.0.2.11', undefined, send);
		expect(await redis.hget('mta:warming:{warming:192.0.2.11}:state', 'sentToday')).toBe('1');

		const deferral = durableEffectIdentity('smtp-attempt:warming', 'deferral');
		loseFirstEvalResponse(redis, "redis.call('HINCRBY', KEYS[1], ARGV[1], 1)");
		await expect(recordDeferral(redis, '192.0.2.11', deferral)).rejects.toThrow(
			'lost Redis response'
		);
		await recordDeferral(redis, '192.0.2.11', deferral);
		expect(await redis.hget('mta:warming:{warming:192.0.2.11}:daily:2026-07-22', 'deferred')).toBe(
			'1'
		);
	});

	it('does not advance domain backoff twice after response loss', async () => {
		const identity = durableEffectIdentity('smtp-attempt:backoff', '3:domain_failure_record');
		loseFirstEvalResponse(redis, '2 ^ (count - 1)');

		await expect(recordDomainFailure(redis, 'example.com', identity)).rejects.toThrow(
			'lost Redis response'
		);
		await recordDomainFailure(redis, 'example.com', identity);

		expect(await shouldBackoffDomain(redis, 'example.com')).toMatchObject({
			backoff: true,
			retryAfter: 30_000,
		});
	});

	it('does not count the guarded FBL daily control twice after response loss', async () => {
		const identity = durableEffectIdentity('fbl:test', '4:fbl_stats_record');
		loseFirstEvalResponse(redis, "redis.call('HINCRBY', KEYS[1], 'total', 1)");
		const replayGuard = {
			runSecondary: (_effectIdentity: string, apply: (id: typeof identity) => Promise<unknown>) =>
				apply(identity),
		};

		await expect(
			applyBounceEffects(
				[{ kind: 'fbl_stats_record' }],
				{ redis, config: {} as MtaConfig },
				replayGuard
			)
		).rejects.toThrow('lost Redis response');
		await applyBounceEffects(
			[{ kind: 'fbl_stats_record' }],
			{ redis, config: {} as MtaConfig },
			replayGuard
		);

		expect(await redis.hget(fblStatsKey('2026-07-22'), 'total')).toBe('1');
	});
});

function loseFirstEvalResponse(redis: Redis, scriptMarker: string): void {
	const committedEval = redis.eval.bind(redis) as (...args: unknown[]) => Promise<unknown>;
	let loseResponse = true;
	(redis as unknown as { eval: (...args: unknown[]) => Promise<unknown> }).eval = async (
		...args
	) => {
		const result = await committedEval(...args);
		if (loseResponse && String(args[0]).includes(scriptMarker)) {
			loseResponse = false;
			throw new Error('lost Redis response');
		}
		return result;
	};
}
