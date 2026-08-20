/**
 * The privacy-ordering and caching contract of {@link OstrClient}.
 *
 * The assertions that matter most here are about the DNS resolver NOT being
 * called: "snapshot first" is a promise about what a receiver publishes to its
 * resolver, so it has to be tested by counting queries, not by checking that
 * the right number came back.
 *
 * Hydration, sync and the store-mutation paths are in `client.sync.test.ts`.
 */

import { formatDnsTierAnswer } from '@owlat/ostr-core';
import { describe, expect, it } from 'vitest';
import { OstrClient, tierOf } from '../client.js';
import { SnapshotStore } from '../store.js';
import {
	AS_OF,
	entry,
	fakeClock,
	fakeTtlTxtResolver,
	fakeTxtResolver,
	HEAD,
	signedSnapshot,
	ZONE,
} from './fixtures.js';

const DNS_ANSWER = formatDnsTierAnswer({
	v: 1,
	tier: 'warned',
	score: 33,
	policy: 'ostr-policy-v1',
	asof: '2026-08-20T05:00:00Z',
});

const UNKNOWN_ANSWER = formatDnsTierAnswer({
	v: 1,
	tier: 'unknown',
	score: 0,
	policy: 'ostr-policy-v1',
	asof: '2026-08-20T05:00:00Z',
});

const SNAPSHOT_ENTRIES = [entry({ domain: 'known.example' }, 'trusted', 88)];

interface Harness {
	client: OstrClient;
	dnsCalls: string[];
	advance: (seconds: number) => void;
	store: SnapshotStore;
}

async function harness(
	options: { cacheTtlSeconds?: number; withSnapshot?: boolean } = {}
): Promise<Harness> {
	const { snapshot, keys } = signedSnapshot(SNAPSHOT_ENTRIES);
	const resolver = fakeTxtResolver({
		'dnsonly.example.q.ostr.example': [[DNS_ANSWER]],
		'nothing.example.q.ostr.example': [[UNKNOWN_ANSWER]],
	});
	const clock = fakeClock();
	const store = new SnapshotStore({ publicKey: keys.publicKey, allowUnsignedDiffs: true });
	if (options.withSnapshot !== false) await store.adopt(snapshot);
	const client = new OstrClient({
		zone: ZONE,
		resolveTxt: resolver.resolveTxt,
		store,
		now: clock.now,
		...(options.cacheTtlSeconds === undefined ? {} : { cacheTtlSeconds: options.cacheTtlSeconds }),
	});
	return { client, dnsCalls: resolver.calls, advance: clock.advance, store };
}

describe('OstrClient resolution order (lookup privacy, plan §8.3)', () => {
	it('answers from the local snapshot and asks DNS nothing at all', async () => {
		const { client, dnsCalls } = await harness();
		expect(await client.tier({ domain: 'known.example' })).toEqual({
			tier: 'trusted',
			score: 88,
			source: 'snapshot',
			asOf: AS_OF,
			verified: true,
			policy: 'ostr-policy-v1',
			headsAsOf: HEAD.timestamp,
		});
		expect(dnsCalls).toEqual([]);
	});

	it('falls back to DNS only for a subject the snapshot misses', async () => {
		const { client, dnsCalls } = await harness();
		expect(await client.tier({ domain: 'dnsonly.example' })).toEqual({
			tier: 'warned',
			score: 33,
			source: 'dns',
			asOf: '2026-08-20T05:00:00Z',
			verified: false,
			policy: 'ostr-policy-v1',
			headsAsOf: '2026-08-20T05:00:00Z',
		});
		expect(dnsCalls).toEqual(['dnsonly.example.q.ostr.example']);
	});

	it('returns null when both paths miss', async () => {
		const { client, dnsCalls } = await harness();
		expect(await client.tier({ domain: 'nobody.example' })).toBeNull();
		expect(dnsCalls).toEqual(['nobody.example.q.ostr.example']);
	});

	it('never queries DNS when the caller forbids it, even on a miss', async () => {
		const { client, dnsCalls } = await harness();
		expect(await client.tier({ domain: 'dnsonly.example' }, { allowDns: false })).toBeNull();
		expect(dnsCalls).toEqual([]);
	});

	it('never queries DNS when no resolver was injected', async () => {
		const { snapshot, keys } = signedSnapshot(SNAPSHOT_ENTRIES);
		const store = new SnapshotStore({ publicKey: keys.publicKey });
		await store.adopt(snapshot);
		const client = new OstrClient({ zone: ZONE, store, now: fakeClock().now });
		expect(await client.tier({ domain: 'dnsonly.example' })).toBeNull();
		expect(await client.tier({ domain: 'known.example' })).toMatchObject({ source: 'snapshot' });
	});

	it('uses DNS for everything when there is no snapshot yet', async () => {
		const { client, dnsCalls } = await harness({ withSnapshot: false });
		expect(await client.tier({ domain: 'dnsonly.example' })).toMatchObject({ source: 'dns' });
		expect(dnsCalls).toEqual(['dnsonly.example.q.ostr.example']);
	});

	it('marks a diff-updated entry as such, and as unverified', async () => {
		const { client, store, dnsCalls } = await harness();
		await store.applyDiffs([
			{
				seq: 1,
				asOf: '2026-08-20T12:00:00Z',
				entry: entry({ domain: 'known.example' }, 'flagged', 6),
			},
		]);
		expect(await client.tier({ domain: 'known.example' })).toMatchObject({
			tier: 'flagged',
			score: 6,
			// Nothing signs a diff entry, and the answer says so rather than
			// inheriting the snapshot's provenance.
			source: 'diff',
			verified: false,
			asOf: '2026-08-20T12:00:00Z',
		});
		expect(dnsCalls).toEqual([]);
	});

	it('reports a snapshot answer as unverified when the store holds no key', async () => {
		const { snapshot } = signedSnapshot(SNAPSHOT_ENTRIES);
		const store = new SnapshotStore();
		await store.adopt(snapshot);
		const client = new OstrClient({ store, now: fakeClock().now });
		expect(await client.tier({ domain: 'known.example' })).toMatchObject({ verified: false });
	});

	it('answers nothing for a subject that is neither a domain nor an IP', async () => {
		const { client, dnsCalls } = await harness();
		expect(await client.tier({})).toBeNull();
		expect(dnsCalls).toEqual([]);
	});

	it.each([
		['a name with a space', { domain: 'a b.example' }],
		['a name with a newline', { domain: 'evil.example\nmore' }],
		['a 300-byte name', { domain: `${'x'.repeat(300)}.example` }],
	])('does not put %s on the wire', async (_label, subject) => {
		const { client, dnsCalls } = await harness();
		expect(await client.tier(subject)).toBeNull();
		expect(dnsCalls).toEqual([]);
	});
});

describe('OstrClient outcomes (spec 08 §8.1)', () => {
	it('gives NXDOMAIN and tier=unknown the same verdict', async () => {
		const { client } = await harness();
		// The two shapes an aggregator may choose between. §8.1: "Clients MUST
		// treat both the same way", and `tierOf` is where that is implemented
		// once instead of in every caller.
		const missing = await client.tier({ domain: 'nobody.example' });
		const unknown = await client.tier({ domain: 'nothing.example' });
		expect(missing).toBeNull();
		expect(unknown).toMatchObject({ tier: 'unknown', score: 0 });
		expect(tierOf(missing)).toBe('unknown');
		expect(tierOf(unknown)).toBe('unknown');
		expect(tierOf(missing)).toBe(tierOf(unknown));
	});

	it('keeps a lookup failure distinct from an unscored sender', async () => {
		const client = new OstrClient({
			zone: ZONE,
			now: fakeClock().now,
			resolveTxt: () => Promise.reject(Object.assign(new Error('servfail'), { code: 'ESERVFAIL' })),
		});
		const failed = await client.resolveTier({ domain: 'flaky.example' });
		expect(failed.status).toBe('error');
		if (failed.status !== 'error') return;
		expect(failed.errors[0]).toContain('resolver failed');
		// The convenience wrapper collapses it, which is why the discriminated
		// call exists for anyone who needs the difference.
		expect(await client.tier({ domain: 'flaky.example' })).toBeNull();
	});

	it('reports an unusable subject as an error, not as an unscored sender', async () => {
		const { client } = await harness();
		const result = await client.resolveTier({ domain: '   ' });
		expect(result).toMatchObject({ status: 'error' });
	});

	it('reports a genuine miss as `none`', async () => {
		const { client } = await harness();
		expect(await client.resolveTier({ domain: 'nobody.example' })).toEqual({ status: 'none' });
	});
});

describe('OstrClient cache (fake clock)', () => {
	it('serves a repeat lookup from cache without a second query', async () => {
		const { client, dnsCalls } = await harness({ cacheTtlSeconds: 3600 });
		const first = await client.tier({ domain: 'dnsonly.example' });
		const second = await client.tier({ domain: 'dnsonly.example' });
		expect(first).toMatchObject({ source: 'dns', score: 33 });
		expect(second).toMatchObject({ source: 'cache', score: 33, asOf: '2026-08-20T05:00:00Z' });
		expect(dnsCalls).toHaveLength(1);
	});

	it('re-queries once the TTL has elapsed, and not a second before', async () => {
		const { client, dnsCalls, advance } = await harness({ cacheTtlSeconds: 3600 });
		await client.tier({ domain: 'dnsonly.example' });
		advance(3599);
		expect(await client.tier({ domain: 'dnsonly.example' })).toMatchObject({ source: 'cache' });
		expect(dnsCalls).toHaveLength(1);
		advance(1);
		expect(await client.tier({ domain: 'dnsonly.example' })).toMatchObject({ source: 'dns' });
		expect(dnsCalls).toHaveLength(2);
	});

	it('honours the record`s own TTL over its configured ceiling (§8.1)', async () => {
		// An aggregator publishing 60s on a fast-moving subject must not be
		// overridden by an hour of cached `warned`.
		const resolver = fakeTtlTxtResolver({ 'dnsonly.example.q.ostr.example': [[DNS_ANSWER]] }, 60);
		const clock = fakeClock();
		const client = new OstrClient({
			zone: ZONE,
			resolveTxt: resolver.resolveTxt,
			now: clock.now,
			cacheTtlSeconds: 3600,
		});
		await client.tier({ domain: 'dnsonly.example' });
		clock.advance(59);
		expect(await client.tier({ domain: 'dnsonly.example' })).toMatchObject({ source: 'cache' });
		clock.advance(1);
		expect(await client.tier({ domain: 'dnsonly.example' })).toMatchObject({ source: 'dns' });
		expect(resolver.calls).toHaveLength(2);
	});

	it('keeps the configured TTL as a ceiling when the record`s is longer', async () => {
		const resolver = fakeTtlTxtResolver(
			{ 'dnsonly.example.q.ostr.example': [[DNS_ANSWER]] },
			86_400
		);
		const clock = fakeClock();
		const client = new OstrClient({
			zone: ZONE,
			resolveTxt: resolver.resolveTxt,
			now: clock.now,
			cacheTtlSeconds: 300,
		});
		await client.tier({ domain: 'dnsonly.example' });
		clock.advance(300);
		expect(await client.tier({ domain: 'dnsonly.example' })).toMatchObject({ source: 'dns' });
	});

	it('caches a miss, so a stream of mail from an unscored sender is not a stream of queries', async () => {
		const { client, dnsCalls } = await harness({ cacheTtlSeconds: 3600 });
		expect(await client.tier({ domain: 'nobody.example' })).toBeNull();
		expect(await client.tier({ domain: 'nobody.example' })).toBeNull();
		expect(dnsCalls).toHaveLength(1);
	});

	it('does not cache a resolver failure, which says nothing about the sender', async () => {
		const clock = fakeClock();
		let attempts = 0;
		const client = new OstrClient({
			zone: ZONE,
			now: clock.now,
			resolveTxt: () => {
				attempts += 1;
				return Promise.reject(Object.assign(new Error('servfail'), { code: 'ESERVFAIL' }));
			},
		});
		expect(await client.tier({ domain: 'flaky.example' })).toBeNull();
		expect(await client.tier({ domain: 'flaky.example' })).toBeNull();
		expect(attempts).toBe(2);
	});

	it('collapses a burst of concurrent lookups into one query', async () => {
		// An MTA taking eight connections from one sender at once would
		// otherwise publish the same name to its resolver eight times.
		let queries = 0;
		let release = (): void => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const client = new OstrClient({
			zone: ZONE,
			now: fakeClock().now,
			resolveTxt: async () => {
				queries += 1;
				await gate;
				return [[DNS_ANSWER]];
			},
		});

		const burst = Array.from({ length: 8 }, () => client.tier({ domain: 'busy.example' }));
		release();
		const answers = await Promise.all(burst);

		expect(queries).toBe(1);
		expect(answers.every((answer) => answer?.score === 33)).toBe(true);
		// The in-flight entry is released, so a later lookup still works.
		expect(await client.tier({ domain: 'busy.example' })).toMatchObject({ source: 'cache' });
	});

	it('serves the snapshot from cache on repeat, and `refresh` goes back to the store', async () => {
		const { client, store } = await harness();
		expect(await client.tier({ domain: 'known.example' })).toMatchObject({ source: 'snapshot' });
		expect(await client.tier({ domain: 'known.example' })).toMatchObject({ source: 'cache' });
		await store.applyDiffs([
			{ seq: 1, asOf: AS_OF, entry: entry({ domain: 'known.example' }, 'flagged', 2) },
		]);
		expect(await client.tier({ domain: 'known.example' }, { refresh: true })).toMatchObject({
			source: 'diff',
			score: 2,
		});
	});

	it('holds nothing when the TTL is zero', async () => {
		const { client, dnsCalls } = await harness({ cacheTtlSeconds: 0 });
		await client.tier({ domain: 'dnsonly.example' });
		await client.tier({ domain: 'dnsonly.example' });
		expect(dnsCalls).toHaveLength(2);
	});

	it('bounds the cache at the configured size, so a dictionary attack cannot grow it', async () => {
		const resolver = fakeTxtResolver({});
		const client = new OstrClient({
			zone: ZONE,
			resolveTxt: resolver.resolveTxt,
			now: fakeClock().now,
			maxCacheEntries: 2,
		});
		for (const name of ['a', 'b', 'c']) await client.tier({ domain: `${name}.example` });
		// `a` was evicted, so asking again is a query rather than a cached miss.
		await client.tier({ domain: 'a.example' });
		expect(resolver.calls).toEqual([
			'a.example.q.ostr.example',
			'b.example.q.ostr.example',
			'c.example.q.ostr.example',
			'a.example.q.ostr.example',
		]);
	});

	it('keys the cache by subject, not by name shape', async () => {
		const { client, dnsCalls } = await harness();
		await client.tier({ domain: 'dnsonly.example' });
		expect(await client.tier({ domain: 'DNSONLY.example.' })).toMatchObject({ source: 'cache' });
		expect(dnsCalls).toHaveLength(1);
	});
});
