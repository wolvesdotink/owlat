/**
 * OSTR tier lookups on the inbound path (plan §12.2) — the fail-open contract.
 *
 * The property under test is not "the lookup works": that is
 * `@owlat/ostr-client`'s, and it is tested there. It is that NOTHING the
 * registry does can reach the mail. Every abnormal outcome — disabled,
 * unconfigured, NXDOMAIN, malformed record, two records at one name, resolver
 * error, silence — has to leave the message exactly as it would have been, and
 * the silence case has to land there within the configured timeout rather than
 * whenever DNS gives up.
 *
 * Three more, each of which was a real bug in an earlier revision:
 *
 *   - `::ffff:` ADDRESSES. A dual-stack listener hands `onConnect` a v4 peer as
 *     `::ffff:203.0.113.10`, which the query-name rule would expand into a
 *     32-nibble IPv6 name no aggregator publishes.
 *   - `error` IS NOT A VERDICT. A domain lookup that failed must not fall
 *     through to the connecting IP's standing (spec 08 §8.1).
 *   - TTLs. A tier answer must not be pinned for the auth cache's hour.
 *
 * The lookups run through a REAL `OstrClient` here, not a stub, because the
 * subject-key and query-name rules being asserted are the client's and a stub
 * would assert this file's idea of them instead.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { RedisLike } from '@owlat/mail-auth';
import { OstrClient, type ResolveTxt } from '@owlat/ostr-client';
import {
	lookupOstrDomainTier,
	lookupOstrIpTier,
	resolveOstrSignal,
	type OstrLookupConfig,
	type OstrLookupDeps,
	type OstrLookupOutcome,
} from '../ostrLookup.js';
import {
	createInboundAuthResolvers,
	makeNodeBaseResolver,
	OSTR_TIER_MAX_TTL_SECONDS,
	type DnsResolveFn,
} from '../inboundAuthResolver.js';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const ZONE = 'ostr.test';
const TRUSTED = 'v=1; tier=trusted; score=82; policy=v1; asof=2026-08-20T00:00:00Z';
const FLAGGED = 'v=1; tier=flagged; score=4; policy=v1; asof=2026-08-20T00:00:00Z';

function makeConfig(overrides: Partial<OstrLookupConfig> = {}): OstrLookupConfig {
	return { ostrEnabled: true, ostrLookupTimeoutMs: 50, ...overrides };
}

/** Deps over a real client with no aggregator: the DNS-fallback-only shape. */
function makeDeps(resolveTxt: ResolveTxt, config = makeConfig()): OstrLookupDeps {
	return {
		config,
		client: new OstrClient({ zone: ZONE, resolveTxt, now: () => Math.floor(Date.now() / 1000) }),
	};
}

/** A TXT resolver over a static zone; absent names answer with no records. */
function zoneResolver(zone: Record<string, string[][]> = {}): ResolveTxt & { calls: string[] } {
	const calls: string[] = [];
	const resolve = async (name: string) => {
		calls.push(name);
		return zone[name] ?? [];
	};
	return Object.assign(resolve, { calls });
}

describe('OSTR lookups — no signal, no lookups', () => {
	it('issues no query at all when OSTR is disabled', async () => {
		const resolveTxt = zoneResolver({ [`example.com.q.${ZONE}`]: [[TRUSTED]] });
		const deps = makeDeps(resolveTxt, makeConfig({ ostrEnabled: false }));

		expect(await lookupOstrDomainTier(deps, 'example.com')).toEqual({ status: 'none' });
		expect(await lookupOstrIpTier(deps, '203.0.113.10')).toEqual({ status: 'none' });
		expect(
			await resolveOstrSignal(deps, {
				dkimSigningDomain: 'example.com',
				connectionIpTier: Promise.resolve({ status: 'answer' } as OstrLookupOutcome),
			})
		).toBeNull();
		expect(resolveTxt.calls).toEqual([]);
	});

	it('issues no query when there is no client to ask', async () => {
		const deps: OstrLookupDeps = { config: makeConfig(), client: null };
		expect(await lookupOstrDomainTier(deps, 'example.com')).toEqual({ status: 'none' });
		expect(await resolveOstrSignal(deps, { dkimSigningDomain: 'example.com' })).toBeNull();
	});
});

describe('OSTR lookups — answers', () => {
	it('parses the tier and score of a domain answer', async () => {
		const resolveTxt = zoneResolver({ [`example.com.q.${ZONE}`]: [[TRUSTED]] });
		const outcome = await lookupOstrDomainTier(makeDeps(resolveTxt), 'example.com');

		expect(outcome).toEqual({ status: 'answer', signal: { tier: 'trusted', score: 82 } });
		expect(resolveTxt.calls).toEqual([`example.com.q.${ZONE}`]);
	});

	it('parses an IP answer off the reversed-octet name', async () => {
		const resolveTxt = zoneResolver({ [`10.113.0.203.ip.q.${ZONE}`]: [[FLAGGED]] });
		const outcome = await lookupOstrIpTier(makeDeps(resolveTxt), '203.0.113.10');

		expect(outcome).toEqual({ status: 'answer', signal: { tier: 'flagged', score: 4 } });
	});

	it('folds an IPv4-mapped IPv6 peer onto the SAME name as its v4 spelling', async () => {
		// What a dual-stack listener actually reports. Without the fold this asks
		// for a 32-nibble IPv6 name and gets NXDOMAIN for every v4 sender alive.
		const resolveTxt = zoneResolver({ [`10.113.0.203.ip.q.${ZONE}`]: [[FLAGGED]] });
		const outcome = await lookupOstrIpTier(makeDeps(resolveTxt), '::ffff:203.0.113.10');

		expect(resolveTxt.calls).toEqual([`10.113.0.203.ip.q.${ZONE}`]);
		expect(outcome).toEqual({ status: 'answer', signal: { tier: 'flagged', score: 4 } });
	});

	it('asks nothing for an address or a name that is not one', async () => {
		const resolveTxt = zoneResolver();
		const deps = makeDeps(resolveTxt);

		expect(await lookupOstrIpTier(deps, 'not-an-address')).toEqual({ status: 'none' });
		expect(await lookupOstrDomainTier(deps, 'not a hostname')).toEqual({ status: 'none' });
		expect(resolveTxt.calls).toEqual([]);
	});
});

describe('OSTR lookups — a failure is never a verdict about the sender', () => {
	it('reports "no evidence" for a name with no record (NXDOMAIN)', async () => {
		expect(
			await lookupOstrDomainTier(
				makeDeps(async () => []),
				'example.com'
			)
		).toEqual({
			status: 'none',
		});
	});

	// An answer that exists but cannot be used says something is wrong with the
	// ZONE, not that nobody has evidence about the sender — so it is classified
	// with the transport failures, and (below) does not fall through to the IP.
	const failures: Array<[string, ResolveTxt]> = [
		['a record that does not parse', async () => [['not an ostr answer']]],
		['two answers at one name (spec 08 §8.1)', async () => [[TRUSTED], [FLAGGED]]],
		[
			'a resolver that rejects',
			async () => {
				throw new Error('SERVFAIL');
			},
		],
		['a resolver that rejects with no Error at all', () => Promise.reject('nope')],
	];

	for (const [label, resolveTxt] of failures) {
		it(`reports "lookup failed" for ${label}`, async () => {
			expect(await lookupOstrDomainTier(makeDeps(resolveTxt), 'example.com')).toEqual({
				status: 'error',
			});
		});
	}

	it('gives up at the timeout instead of waiting on a silent resolver', async () => {
		// Never settles: the stand-in for an aggregator's nameserver black-holing
		// queries, which is the case an unbounded lookup would hang `onData` on.
		const resolveTxt: ResolveTxt = () => new Promise(() => {});
		const started = Date.now();
		const outcome = await lookupOstrDomainTier(
			makeDeps(resolveTxt, makeConfig({ ostrLookupTimeoutMs: 30 })),
			'example.com'
		);

		expect(outcome).toEqual({ status: 'error' });
		expect(Date.now() - started).toBeLessThan(1000);
	});
});

describe('resolveOstrSignal — which identity is asked about', () => {
	/** The connection-time IP outcome `onConnect` would have put on the session. */
	function connectionIp(outcome: OstrLookupOutcome): Promise<OstrLookupOutcome> {
		return Promise.resolve(outcome);
	}

	it('asks about the DKIM-authenticated domain first', async () => {
		const resolveTxt = zoneResolver({ [`example.com.q.${ZONE}`]: [[TRUSTED]] });
		const signal = await resolveOstrSignal(makeDeps(resolveTxt), {
			dkimSigningDomain: 'example.com',
			connectionIpTier: connectionIp({ status: 'answer', signal: { tier: 'flagged', score: 4 } }),
		});

		// A proven identity beats a rented position, and ONE lookup is the
		// per-message budget: the IP half already happened, at connection time.
		expect(signal).toEqual({ tier: 'trusted', score: 82 });
		expect(resolveTxt.calls).toEqual([`example.com.q.${ZONE}`]);
	});

	it('falls back to the connection IP when the domain has no entry', async () => {
		const resolveTxt = zoneResolver();
		const signal = await resolveOstrSignal(makeDeps(resolveTxt), {
			dkimSigningDomain: 'unscored.example',
			connectionIpTier: connectionIp({ status: 'answer', signal: { tier: 'flagged', score: 4 } }),
		});

		expect(signal).toEqual({ tier: 'flagged', score: 4 });
		expect(resolveTxt.calls).toEqual([`unscored.example.q.${ZONE}`]);
	});

	it('does NOT substitute the IP when the domain lookup failed', async () => {
		// spec 08 §8.1: `error` is a fact about the lookup. Reporting the shared
		// cloud IP's `flagged` as a trusted domain's standing because one query
		// SERVFAILed is exactly the confusion the two statuses exist to prevent.
		const resolveTxt: ResolveTxt = () => Promise.reject(new Error('SERVFAIL'));
		const signal = await resolveOstrSignal(makeDeps(resolveTxt), {
			dkimSigningDomain: 'example.com',
			connectionIpTier: connectionIp({ status: 'answer', signal: { tier: 'flagged', score: 4 } }),
		});

		expect(signal).toBeNull();
	});

	it('uses the connection IP alone when no signature verified', async () => {
		const signal = await resolveOstrSignal(makeDeps(zoneResolver()), {
			connectionIpTier: connectionIp({ status: 'answer', signal: { tier: 'flagged', score: 4 } }),
		});

		expect(signal).toEqual({ tier: 'flagged', score: 4 });
	});

	it('returns null when the message offers no identity to ask about', async () => {
		const resolveTxt = zoneResolver();
		expect(await resolveOstrSignal(makeDeps(resolveTxt), {})).toBeNull();
		expect(resolveTxt.calls).toEqual([]);
	});

	it('survives a connection-time lookup that rejected outright', async () => {
		const signal = await resolveOstrSignal(makeDeps(zoneResolver()), {
			connectionIpTier: Promise.reject(new Error('boom')),
		});

		expect(signal).toBeNull();
	});
});

describe('OSTR lookups ride a bounded shared DNS cache', () => {
	beforeEach(async () => {
		// `ioredis-mock` shares one backing store across instances; wipe it so a
		// lookup-count assertion cannot depend on test order (the repo pattern).
		await (new RedisMock() as unknown as { flushall: () => Promise<unknown> }).flushall();
	});

	/** The production TXT shape: `dns/promises` surfaces NO TTL for TXT. */
	const txtWithoutTtl = (records: Record<string, string[][]>): DnsResolveFn => {
		return async (name, type) => {
			if (type === 'TXT' && records[name] !== undefined) {
				return { records: records[name] };
			}
			const err = new Error(`ENOTFOUND ${name}`) as Error & { code: string };
			err.code = 'ENOTFOUND';
			throw err;
		};
	};

	it("pins a tier answer for minutes, not the auth cache's hour", async () => {
		// Asserted against the shape `nodeDnsResolve` really produces for TXT — no
		// TTL at all — because that is the case where a substitute TTL is invented.
		// spec 08 §8.1 forbids pinning past a record's own life, and aggregators
		// publish "around one hour": 300s is under any of them.
		const stored: Array<{ key: string; ttl: number }> = [];
		const redis = {
			get: () => Promise.resolve(null),
			set: (key: string, _value: string, _mode: 'EX', ttlSeconds: number) => {
				stored.push({ key, ttl: ttlSeconds });
				return Promise.resolve('OK');
			},
		} satisfies RedisLike;
		const resolvers = createInboundAuthResolvers(
			redis,
			makeNodeBaseResolver(txtWithoutTtl({ [`example.com.q.${ZONE}`]: [[TRUSTED]] }))
		);

		const answer = await resolvers.ostrTxt(`example.com.q.${ZONE}`);

		expect(OSTR_TIER_MAX_TTL_SECONDS).toBeLessThanOrEqual(600);
		expect(stored).toEqual([
			{ key: `mailauth:dns:ostr:TXT:example.com.q.${ZONE}`, ttl: OSTR_TIER_MAX_TTL_SECONDS },
		]);
		expect(answer).toEqual({
			records: [[TRUSTED]],
			ttlSeconds: OSTR_TIER_MAX_TTL_SECONDS,
		});
	});

	it('queries the aggregator once per name per pin, however many messages arrive', async () => {
		let baseCalls = 0;
		const dns = txtWithoutTtl({ [`example.com.q.${ZONE}`]: [[TRUSTED]] });
		const counting: DnsResolveFn = (name, type) => {
			baseCalls += 1;
			return dns(name, type);
		};
		const redis = new RedisMock() as unknown as RedisLike;
		const resolvers = createInboundAuthResolvers(redis, makeNodeBaseResolver(counting));
		const deps = makeDeps(resolvers.ostrTxt);

		const first = await lookupOstrDomainTier(deps, 'example.com');
		const second = await lookupOstrDomainTier(deps, 'example.com');

		expect(first).toEqual({ status: 'answer', signal: { tier: 'trusted', score: 82 } });
		expect(second).toEqual(first);
		expect(baseCalls).toBe(1);
	});

	it('reports a cache HIT as "do not pin again" rather than as a fresh TTL', async () => {
		// Two caches, one expiry: the client must not add its own hour on top of
		// the Redis entry's five minutes.
		const redis = new RedisMock() as unknown as RedisLike;
		const resolvers = createInboundAuthResolvers(
			redis,
			makeNodeBaseResolver(txtWithoutTtl({ [`example.com.q.${ZONE}`]: [[TRUSTED]] }))
		);

		await resolvers.ostrTxt(`example.com.q.${ZONE}`);
		const hit = await resolvers.ostrTxt(`example.com.q.${ZONE}`);

		expect(hit).toEqual({ records: [[TRUSTED]], ttlSeconds: 0 });
	});

	it('surfaces a cached NXDOMAIN as "no evidence", not as an error', async () => {
		const redis = new RedisMock() as unknown as RedisLike;
		const resolvers = createInboundAuthResolvers(redis, makeNodeBaseResolver(txtWithoutTtl({})));

		expect(await lookupOstrDomainTier(makeDeps(resolvers.ostrTxt), 'unscored.example')).toEqual({
			status: 'none',
		});
	});

	it('treats a cache entry of an unexpected shape as no record at all', async () => {
		// A stale or poisoned entry must not reach the answer parser as arbitrary
		// JSON. "No evidence" is the fail-open outcome every OSTR failure lands on.
		const redis = {
			get: () => Promise.resolve(JSON.stringify({ records: [{ not: 'a txt record' }] })),
			set: () => Promise.resolve('OK'),
		} satisfies RedisLike;
		const resolvers = createInboundAuthResolvers(redis, makeNodeBaseResolver(txtWithoutTtl({})));

		expect(await resolvers.ostrTxt(`example.com.q.${ZONE}`)).toEqual({
			records: [],
			ttlSeconds: 0,
		});
		expect(await lookupOstrDomainTier(makeDeps(resolvers.ostrTxt), 'example.com')).toEqual({
			status: 'none',
		});
	});
});
