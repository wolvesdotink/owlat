/**
 * The facade's data-lifecycle half: construction, hydrating a persisted set at
 * startup, syncing from the aggregator, and keeping the cache honest when the
 * scored set moves underneath it.
 *
 * The startup path is the one an operator actually runs — a process that comes
 * up, reads its file and answers the first message without asking anyone
 * anything — so it is tested by asserting that the resolver is never touched.
 */

import { formatDnsTierAnswer } from '@owlat/ostr-core';
import { describe, expect, it } from 'vitest';
import { OstrClient } from '../client.js';
import { createMemoryPersistence, SnapshotStore } from '../store.js';
import { diffPath, SNAPSHOT_PATH } from '../sync.js';
import {
	diff,
	entry,
	fakeClock,
	fakeFetcher,
	fakeTxtResolver,
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

const SNAPSHOT_ENTRIES = [
	entry({ domain: 'known.example' }, 'trusted', 88),
	entry({ domain: 'bad.example' }, 'flagged', 4),
];

describe('OstrClient construction', () => {
	it('refuses to silently drop a caller`s durability configuration', () => {
		expect(
			() =>
				new OstrClient({
					store: new SnapshotStore(),
					persistence: createMemoryPersistence(),
					now: fakeClock().now,
				})
		).toThrow(/either `store` or `persistence`/);
	});

	it('refuses an unsigned-diff setting that would apply to a store it did not build', () => {
		expect(
			() =>
				new OstrClient({
					store: new SnapshotStore(),
					allowUnsignedDiffs: true,
					now: fakeClock().now,
				})
		).toThrow(/on the store you supplied/);
	});
});

describe('OstrClient.hydrate', () => {
	/** A persisted, signed snapshot, as a previous run would have left it. */
	async function persisted(): Promise<{
		persistence: ReturnType<typeof createMemoryPersistence>;
		publicKey: string;
	}> {
		const { snapshot, keys } = signedSnapshot(SNAPSHOT_ENTRIES);
		const persistence = createMemoryPersistence();
		const writer = new SnapshotStore({ persistence, publicKey: keys.publicKey });
		await writer.adopt(snapshot);
		return { persistence, publicKey: keys.publicKey };
	}

	it('starts from the local file and answers without asking DNS anything', async () => {
		const { persistence, publicKey } = await persisted();
		const resolver = fakeTxtResolver({ 'known.example.q.ostr.example': [[DNS_ANSWER]] });
		const client = new OstrClient({
			zone: ZONE,
			resolveTxt: resolver.resolveTxt,
			// The convenience branch: the client builds the store from the
			// adapter and the aggregator's key.
			persistence,
			aggregator: { fetchJson: fakeFetcher({}).fetchJson, publicKey },
			now: fakeClock().now,
		});

		expect(await client.hydrate()).toMatchObject({ status: 'loaded', entries: 2 });
		expect(await client.tier({ domain: 'known.example' })).toMatchObject({
			source: 'snapshot',
			score: 88,
			verified: true,
		});
		expect(resolver.calls).toEqual([]);
	});

	it('drops answers cached before the load, rather than serving them over the new set', async () => {
		const { persistence, publicKey } = await persisted();
		const resolver = fakeTxtResolver({ 'known.example.q.ostr.example': [[DNS_ANSWER]] });
		const client = new OstrClient({
			zone: ZONE,
			resolveTxt: resolver.resolveTxt,
			persistence,
			aggregator: { fetchJson: fakeFetcher({}).fetchJson, publicKey },
			now: fakeClock().now,
		});

		// Before hydrating there is nothing local, so DNS answers and the
		// answer is cached.
		expect(await client.tier({ domain: 'known.example' })).toMatchObject({ source: 'dns' });
		await client.hydrate();
		expect(await client.tier({ domain: 'known.example' })).toMatchObject({
			source: 'snapshot',
			score: 88,
		});
	});

	it('reports a rejected file and keeps answering from DNS', async () => {
		const { snapshot, keys } = signedSnapshot(SNAPSHOT_ENTRIES);
		const writer = createMemoryPersistence();
		await new SnapshotStore({ persistence: writer }).adopt(snapshot);
		const tampered = ((await writer.load()) ?? '').replace('"score":4', '"score":99');
		const resolver = fakeTxtResolver({ 'known.example.q.ostr.example': [[DNS_ANSWER]] });
		const client = new OstrClient({
			zone: ZONE,
			resolveTxt: resolver.resolveTxt,
			persistence: createMemoryPersistence(tampered),
			aggregator: { fetchJson: fakeFetcher({}).fetchJson, publicKey: keys.publicKey },
			now: fakeClock().now,
		});

		expect(await client.hydrate()).toMatchObject({ status: 'rejected' });
		expect(await client.tier({ domain: 'known.example' })).toMatchObject({ source: 'dns' });
	});

	it('reports an empty store when the client was built without persistence', async () => {
		const client = new OstrClient({ now: fakeClock().now });
		expect(await client.hydrate()).toEqual({ status: 'empty' });
	});
});

describe('OstrClient sync', () => {
	it('adopts a snapshot through the configured aggregator and drops stale cache', async () => {
		const { snapshot, keys } = signedSnapshot(SNAPSHOT_ENTRIES);
		const resolver = fakeTxtResolver({ 'known.example.q.ostr.example': [[DNS_ANSWER]] });
		const client = new OstrClient({
			zone: ZONE,
			resolveTxt: resolver.resolveTxt,
			aggregator: {
				fetchJson: fakeFetcher({ [SNAPSHOT_PATH]: snapshot }).fetchJson,
				publicKey: keys.publicKey,
			},
			now: fakeClock().now,
		});

		// Before the sync there is no local data, so the DNS answer is used.
		expect(await client.tier({ domain: 'known.example' })).toMatchObject({ source: 'dns' });
		expect(await client.syncSnapshot()).toMatchObject({ ok: true, entries: 2 });
		// After it, the same lookup is answered locally and leaks nothing.
		expect(await client.tier({ domain: 'known.example' })).toMatchObject({
			source: 'snapshot',
			score: 88,
		});
		expect(resolver.calls).toHaveLength(1);
	});

	it('applies the diff feed and clears the answers it invalidates', async () => {
		const { snapshot, keys } = signedSnapshot(SNAPSHOT_ENTRIES);
		const client = new OstrClient({
			aggregator: {
				fetchJson: fakeFetcher({
					[SNAPSHOT_PATH]: snapshot,
					[diffPath(0)]: [diff(4, entry({ domain: 'known.example' }, 'warned', 30))],
				}).fetchJson,
				publicKey: keys.publicKey,
			},
			allowUnsignedDiffs: true,
			now: fakeClock().now,
		});

		await client.syncSnapshot();
		expect(await client.tier({ domain: 'known.example' })).toMatchObject({ score: 88 });
		expect(await client.syncDiff()).toMatchObject({ ok: true, applied: 1, latestSeq: 4 });
		// The cached 88 is gone, not served for the rest of the hour.
		expect(await client.tier({ domain: 'known.example' })).toMatchObject({
			source: 'diff',
			score: 30,
			verified: false,
		});
	});

	it('refuses the diff feed by default, leaving the signed set in place', async () => {
		const { snapshot, keys } = signedSnapshot(SNAPSHOT_ENTRIES);
		const fetcher = fakeFetcher({
			[SNAPSHOT_PATH]: snapshot,
			[diffPath(0)]: [diff(4, entry({ domain: 'bad.example' }, 'trusted', 99))],
		});
		const client = new OstrClient({
			aggregator: { fetchJson: fetcher.fetchJson, publicKey: keys.publicKey },
			now: fakeClock().now,
		});

		await client.syncSnapshot();
		expect(await client.syncDiff()).toMatchObject({ ok: false });
		expect(await client.tier({ domain: 'bad.example' })).toMatchObject({ tier: 'flagged' });
		expect(fetcher.calls).toEqual([SNAPSHOT_PATH]);
	});

	it('reports a missing aggregator rather than pretending to sync', async () => {
		const client = new OstrClient({ now: fakeClock().now });
		expect(await client.syncSnapshot()).toEqual({
			ok: false,
			errors: ['no aggregator configured'],
		});
		expect(await client.syncDiff()).toEqual({ ok: false, errors: ['no aggregator configured'] });
	});

	it('refuses a forged snapshot and keeps answering from the verified one', async () => {
		const { snapshot, keys } = signedSnapshot(SNAPSHOT_ENTRIES);
		const forged = { ...snapshot, entries: [entry({ domain: 'known.example' }, 'flagged', 1)] };
		const store = new SnapshotStore({ publicKey: keys.publicKey });
		await store.adopt(snapshot);
		const client = new OstrClient({
			store,
			aggregator: {
				fetchJson: fakeFetcher({ [SNAPSHOT_PATH]: forged }).fetchJson,
				publicKey: keys.publicKey,
			},
			now: fakeClock().now,
		});
		expect(await client.syncSnapshot()).toMatchObject({ ok: false });
		expect(await client.tier({ domain: 'known.example' })).toMatchObject({ score: 88 });
	});

	it('exposes the store it is running from', async () => {
		const store = new SnapshotStore();
		const client = new OstrClient({ store, now: fakeClock().now });
		expect(client.snapshotStore()).toBe(store);
	});

	it('notices a caller writing to the store behind its back', async () => {
		const { snapshot, keys } = signedSnapshot(SNAPSHOT_ENTRIES);
		const store = new SnapshotStore({ publicKey: keys.publicKey, allowUnsignedDiffs: true });
		await store.adopt(snapshot);
		const client = new OstrClient({ store, now: fakeClock().now, cacheTtlSeconds: 3600 });

		expect(await client.tier({ domain: 'known.example' })).toMatchObject({ score: 88 });
		// Straight to the store, bypassing the facade's own sync methods.
		await client
			.snapshotStore()
			.applyDiffs([diff(1, entry({ domain: 'known.example' }, 'flagged', 3))]);
		// Without a revision check this would serve the cached 88 for an hour.
		expect(await client.tier({ domain: 'known.example' })).toMatchObject({
			source: 'diff',
			score: 3,
		});
	});
});
