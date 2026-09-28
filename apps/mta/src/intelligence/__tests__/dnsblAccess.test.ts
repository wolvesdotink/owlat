import { beforeEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis-mock';

vi.mock('../../webhooks/convexNotifier.js', () => ({
	notifyConvex: vi.fn().mockResolvedValue(true),
}));
vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../smtp/connectionPool.js', () => ({ pool: { invalidateBindIp: vi.fn() } }));

import {
	prepareSpamhausAccess,
	probeSpamhausZone,
	readSpamhausAccess,
	readSpamhausDqsKey,
	recordSpamhausAccess,
	resetSpamhausAccess,
	storeSpamhausDqsKey,
} from '../dnsblAccess.js';
import { runDnsblCheck } from '../dnsbl.js';
import { checkDnsblDetailed, lookupDnsblZone } from '../dnsblLookup.js';
import { createOwlatHostConfig } from '../../__tests__/helpers/fixtures.js';
import { createRecordingLookupDeps, dnsError, seedActivePools } from './dnsblFixtures.js';

const KEY = 'abcdefghijklmnopqrstuvwxyz';
const KEYED_ZONE = `${KEY}.zen.dq.spamhaus.net`;

/** A resolver scripted per queried name; anything unscripted is NXDOMAIN. */
function scriptedDeps(answers: Record<string, string[] | Error>) {
	const queried: string[] = [];
	const resolve4 = vi.fn(async (hostname: string) => {
		queried.push(hostname);
		const answer = answers[hostname];
		if (answer instanceof Error) throw answer;
		if (answer) return answer;
		throw dnsError('ENOTFOUND');
	});
	return { queried, deps: { ...createRecordingLookupDeps().deps, resolve4 } };
}

describe('lookup reasons', () => {
	it('names the fix each kind of unmeasured answer needs', async () => {
		const { deps } = scriptedDeps({
			'1.0.0.10.refused.test': ['127.255.255.254'],
			'1.0.0.10.limited.test': ['127.255.255.255'],
			'1.0.0.10.rewritten.test': ['198.51.100.7'],
			'1.0.0.10.down.test': dnsError('ETIMEOUT'),
		});
		const reason = async (zone: string) =>
			(await lookupDnsblZone('10.0.0.1', 'spamhaus', zone, { ...deps, quiet: true })).reason;

		expect(await reason('refused.test')).toBe('resolver_refused');
		expect(await reason('limited.test')).toBe('rate_limited');
		expect(await reason('rewritten.test')).toBe('unusable_answer');
		expect(await reason('down.test')).toBe('resolver_unreachable');
		expect(await reason('clean.test')).toBeUndefined();
	});

	it('keeps the concluding reason through the bounded retry', async () => {
		const { deps } = scriptedDeps({ '1.0.0.10.down.test': dnsError('ESERVFAIL') });
		const result = await checkDnsblDetailed('10.0.0.1', 'spamhaus', 'down.test', deps);
		expect(result).toMatchObject({ status: 'unknown', reason: 'resolver_unreachable' });
	});
});

describe('probeSpamhausZone', () => {
	it('trusts a keyed zone only when its test entry answers as listed', async () => {
		const { deps } = scriptedDeps({ [`2.0.0.127.${KEYED_ZONE}`]: ['127.0.0.2', '127.0.0.10'] });
		expect(await probeSpamhausZone(KEYED_ZONE, deps)).toBeUndefined();
	});

	it('reads NXDOMAIN for the test entry as a rejected key, never as clean', async () => {
		const { deps } = scriptedDeps({});
		expect(await probeSpamhausZone(KEYED_ZONE, deps)).toBe('key_rejected');
	});

	it('settles a SERVFAIL with the public zone: an answered control means the key failed', async () => {
		const { deps } = scriptedDeps({
			[`2.0.0.127.${KEYED_ZONE}`]: dnsError('ESERVFAIL'),
			'2.0.0.127.zen.spamhaus.org': ['127.255.255.254'],
		});
		expect(await probeSpamhausZone(KEYED_ZONE, deps)).toBe('key_rejected');
	});

	it('reports an unreachable resolver when the control gets no answer either', async () => {
		const { deps } = scriptedDeps({
			[`2.0.0.127.${KEYED_ZONE}`]: dnsError('ESERVFAIL'),
			'2.0.0.127.zen.spamhaus.org': dnsError('ETIMEOUT'),
		});
		expect(await probeSpamhausZone(KEYED_ZONE, deps)).toBe('resolver_unreachable');
	});

	it('never blames the key for a keyed zone that timed out while the public zone answers', async () => {
		const { queried, deps } = scriptedDeps({
			[`2.0.0.127.${KEYED_ZONE}`]: dnsError('ETIMEOUT'),
			'2.0.0.127.zen.spamhaus.org': ['127.255.255.254'],
		});
		expect(await probeSpamhausZone(KEYED_ZONE, deps)).toBe('resolver_unreachable');
		// No control query: only a SERVFAIL is ambiguous between key and path.
		expect(queried).not.toContain('2.0.0.127.zen.spamhaus.org');
	});

	it('treats other transport errors on the keyed zone as an unreachable resolver', async () => {
		for (const code of ['EREFUSED', 'ECONNREFUSED', 'EAI_AGAIN']) {
			const { deps } = scriptedDeps({
				[`2.0.0.127.${KEYED_ZONE}`]: dnsError(code),
				'2.0.0.127.zen.spamhaus.org': ['127.255.255.254'],
			});
			expect(await probeSpamhausZone(KEYED_ZONE, deps)).toBe('resolver_unreachable');
		}
	});

	it('does not blame the key when the keyed query hits the per-attempt timeout', async () => {
		vi.useFakeTimers();
		try {
			const { deps } = scriptedDeps({ '2.0.0.127.zen.spamhaus.org': ['127.255.255.254'] });
			deps.resolve4.mockImplementation(async (hostname: string) =>
				hostname === `2.0.0.127.${KEYED_ZONE}`
					? new Promise<string[]>(() => {})
					: ['127.255.255.254']
			);
			const pending = probeSpamhausZone(KEYED_ZONE, { ...deps, timeoutMs: 1_000 });
			await vi.advanceTimersByTimeAsync(10_000);
			expect(await pending).toBe('resolver_unreachable');
		} finally {
			vi.useRealTimers();
		}
	});

	it('passes a refusal through as the reason', async () => {
		const { deps } = scriptedDeps({ [`2.0.0.127.${KEYED_ZONE}`]: ['127.255.255.255'] });
		expect(await probeSpamhausZone(KEYED_ZONE, deps)).toBe('rate_limited');
	});
});

describe('the stored DQS key', () => {
	let redis: InstanceType<typeof Redis>;
	beforeEach(async () => {
		redis = new Redis();
		await redis.flushall();
	});

	it('is sealed at rest and reads back as the key', async () => {
		await storeSpamhausDqsKey(redis, KEY);
		const raw = await redis.get('mta:dnsbl:spamhaus-dqs-key');
		expect(raw).not.toContain(KEY);
		expect(await readSpamhausDqsKey(redis)).toBe(KEY);

		await storeSpamhausDqsKey(redis, null);
		expect(await readSpamhausDqsKey(redis)).toBeUndefined();
	});

	it('reads a value it cannot open as absent rather than failing the sweep', async () => {
		await redis.set('mta:dnsbl:spamhaus-dqs-key', 'mtasealed:v1:garbage');
		expect(await readSpamhausDqsKey(redis)).toBeUndefined();
	});

	it('is only handed to the sweep once its test entry answers', async () => {
		await storeSpamhausDqsKey(redis, KEY);
		const ok = scriptedDeps({ [`2.0.0.127.${KEYED_ZONE}`]: ['127.0.0.2'] });
		expect(await prepareSpamhausAccess(redis, ok.deps)).toEqual({ dqsKey: KEY });

		const bad = scriptedDeps({});
		expect(await prepareSpamhausAccess(redis, bad.deps)).toEqual({
			dqsKey: KEY,
			unavailable: 'key_rejected',
		});
	});

	it('makes no query at all without a key', async () => {
		const { deps, queried } = scriptedDeps({});
		expect(await prepareSpamhausAccess(redis, deps)).toEqual({});
		expect(queried).toEqual([]);
	});

	it('reports pending until a sweep has recorded an outcome, and only the key hint', async () => {
		await storeSpamhausDqsKey(redis, KEY);
		expect(await readSpamhausAccess(redis, 'bundled')).toEqual({
			resolver: { configured: 'bundled' },
			spamhaus: { access: 'dqs', keyHint: 'wxyz', status: 'pending' },
		});

		await recordSpamhausAccess(redis, {
			reason: 'resolver_refused',
			path: 'system',
			checkedAt: 1_000,
		});
		expect(await readSpamhausAccess(redis, 'bundled')).toEqual({
			resolver: { configured: 'bundled', lastPath: 'system' },
			spamhaus: {
				access: 'dqs',
				keyHint: 'wxyz',
				status: 'unknown',
				reason: 'resolver_refused',
				checkedAt: 1_000,
			},
		});

		await resetSpamhausAccess(redis);
		expect((await readSpamhausAccess(redis, 'bundled')).spamhaus.status).toBe('pending');
	});
});

describe('the sweep with Spamhaus access', () => {
	let redis: InstanceType<typeof Redis>;
	const config = createOwlatHostConfig();

	beforeEach(async () => {
		redis = new Redis();
		await redis.flushall();
		await seedActivePools(redis, config.ipPools);
	});

	it('records why an address is unmeasured, and what the last check saw', async () => {
		const { deps } = scriptedDeps({
			'1.0.0.10.zen.spamhaus.org': ['127.255.255.254'],
			'2.0.0.10.zen.spamhaus.org': ['127.255.255.254'],
		});
		await runDnsblCheck(redis, config, deps);

		expect(await redis.hget('mta:dnsbl:10.0.0.1', 'unknownReason')).toBe('resolver_refused');
		expect(await redis.hget('mta:dnsbl:10.0.0.1', 'overallStatus')).toBe('unknown');
		expect((await readSpamhausAccess(redis, 'system')).spamhaus).toMatchObject({
			access: 'public',
			status: 'unknown',
			reason: 'resolver_refused',
		});
	});

	it('clears the reason once every zone answers', async () => {
		await redis.hset('mta:dnsbl:10.0.0.1', 'unknownReason', 'resolver_refused');
		const { deps } = scriptedDeps({});
		await runDnsblCheck(redis, config, deps);

		expect(await redis.hget('mta:dnsbl:10.0.0.1', 'unknownReason')).toBe('');
		expect((await readSpamhausAccess(redis, 'system')).spamhaus.status).toBe('ok');
	});

	it('queries the keyed zone once the key passes its test', async () => {
		await storeSpamhausDqsKey(redis, KEY);
		const { deps, queried } = scriptedDeps({ [`2.0.0.127.${KEYED_ZONE}`]: ['127.0.0.2'] });
		await runDnsblCheck(redis, config, deps);

		expect(queried).toContain(`1.0.0.10.${KEYED_ZONE}`);
		expect(queried).not.toContain('1.0.0.10.zen.spamhaus.org');
		expect(await redis.hget('mta:dnsbl:10.0.0.1', 'spamhaus')).toBe('clean');
	});

	it('never reads a failed key as clean: every Spamhaus result is unknown and no address is asked', async () => {
		await storeSpamhausDqsKey(redis, KEY);
		const { deps, queried } = scriptedDeps({});
		await runDnsblCheck(redis, config, deps);

		expect(queried.filter((name) => name.endsWith(KEYED_ZONE))).toEqual([
			`2.0.0.127.${KEYED_ZONE}`,
		]);
		expect(await redis.hget('mta:dnsbl:10.0.0.1', 'spamhaus')).toBe('unknown');
		expect(await redis.hget('mta:dnsbl:10.0.0.1', 'unknownReason')).toBe('key_rejected');
		// Never observed clean, so it stays out of rotation.
		expect(await redis.sismember('mta:ip-pool:active', '10.0.0.1')).toBe(0);
		expect((await readSpamhausAccess(redis, 'system')).spamhaus).toMatchObject({
			status: 'unknown',
			reason: 'key_rejected',
		});
	});
});
