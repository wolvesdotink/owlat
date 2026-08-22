import { generateEd25519KeyPair } from '@owlat/ostr-core';
import { describe, expect, it } from 'vitest';
import { createMemoryPersistence, SnapshotStore } from '../store.js';
import { diffPath, SNAPSHOT_PATH, syncDiff, syncSnapshot } from '../sync.js';
import { diff, entry, fakeFetcher, signedSnapshot } from './fixtures.js';

const ENTRIES = [
	entry({ domain: 'good.example' }, 'trusted', 88),
	entry({ domain: 'bad.example' }, 'flagged', 4),
];

describe('syncSnapshot', () => {
	it('fetches, verifies and adopts the aggregator snapshot', async () => {
		const { snapshot, keys } = signedSnapshot(ENTRIES);
		const fetcher = fakeFetcher({ [SNAPSHOT_PATH]: snapshot });
		const store = new SnapshotStore({ publicKey: keys.publicKey });

		const result = await syncSnapshot({
			fetchJson: fetcher.fetchJson,
			aggregatorPublicKeyBase64: keys.publicKey,
			store,
		});

		expect(result).toMatchObject({ ok: true, entries: 2 });
		expect(fetcher.calls).toEqual(['/v1/snapshot']);
		expect(store.tier({ domain: 'good.example' })?.score).toBe(88);
	});

	it('persists what it adopted, so the next process starts from local data', async () => {
		const { snapshot, keys } = signedSnapshot(ENTRIES);
		const persistence = createMemoryPersistence();
		const store = new SnapshotStore({ persistence, publicKey: keys.publicKey });
		await syncSnapshot({
			fetchJson: fakeFetcher({ [SNAPSHOT_PATH]: snapshot }).fetchJson,
			aggregatorPublicKeyBase64: keys.publicKey,
			store,
		});
		expect(await persistence.load()).toContain('good.example');
	});

	it('REJECTS a snapshot whose signature does not verify and keeps the old set', async () => {
		const { snapshot, keys } = signedSnapshot(ENTRIES);
		const store = new SnapshotStore({ publicKey: keys.publicKey });
		await store.adopt(snapshot);

		const forged = {
			...snapshot,
			entries: [entry({ domain: 'bad.example' }, 'trusted', 99)],
		};
		const result = await syncSnapshot({
			fetchJson: fakeFetcher({ [SNAPSHOT_PATH]: forged }).fetchJson,
			aggregatorPublicKeyBase64: keys.publicKey,
			store,
		});

		expect(result).toEqual({ ok: false, errors: ['snapshot signature did not verify'] });
		expect(store.tier({ domain: 'bad.example' })?.score).toBe(4);
	});

	it('rejects a snapshot signed by a key that is not the configured aggregator', async () => {
		const { snapshot } = signedSnapshot(ENTRIES);
		const store = new SnapshotStore();
		const result = await syncSnapshot({
			fetchJson: fakeFetcher({ [SNAPSHOT_PATH]: snapshot }).fetchJson,
			aggregatorPublicKeyBase64: generateEd25519KeyPair().publicKey,
			store,
		});
		expect(result.ok).toBe(false);
		expect(store.snapshot()).toBeNull();
	});

	it.each([
		['null', null],
		['an array', []],
		['an object with no entries', { v: 1, policy: 'p', asOf: 'now', heads: [], sig: 'x' }],
		[
			'entries that are not scored subjects',
			{ v: 1, policy: 'p', asOf: 'now', heads: [], sig: 'x', entries: [{ subject: {} }] },
		],
		[
			'an entry with an out-of-range score',
			{
				v: 1,
				policy: 'p',
				asOf: 'now',
				heads: [],
				sig: 'x',
				entries: [{ subject: { domain: 'a.example' }, tier: 'trusted', score: 900 }],
			},
		],
	])('rejects %s before it reaches the verifier', async (_label, payload) => {
		const result = await syncSnapshot({
			fetchJson: fakeFetcher({ [SNAPSHOT_PATH]: payload }).fetchJson,
			aggregatorPublicKeyBase64: generateEd25519KeyPair().publicKey,
			store: new SnapshotStore(),
		});
		expect(result).toMatchObject({ ok: false });
	});

	it('reports a transport failure without touching the store', async () => {
		const store = new SnapshotStore();
		const result = await syncSnapshot({
			fetchJson: () => Promise.reject(new Error('connect ECONNREFUSED')),
			aggregatorPublicKeyBase64: 'irrelevant',
			store,
		});
		expect(result).toMatchObject({ ok: false });
		if (result.ok) return;
		expect(result.errors[0]).toContain('fetch failed');
	});
});

describe('diffPath', () => {
	it('builds the cursor query', () => {
		expect(diffPath(0)).toBe('/v1/diff?since=0');
		expect(diffPath(12)).toBe('/v1/diff?since=12');
	});

	it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
		'refuses to build `?since=%p`',
		(since) => {
			expect(() => diffPath(since)).toThrow(/non-negative integer/);
		}
	);
});

describe('syncDiff', () => {
	async function primedStore(
		options: { allowUnsignedDiffs?: boolean } = {}
	): Promise<{ store: SnapshotStore; publicKey: string }> {
		const { snapshot, keys } = signedSnapshot(ENTRIES);
		const store = new SnapshotStore({
			publicKey: keys.publicKey,
			allowUnsignedDiffs: options.allowUnsignedDiffs ?? true,
		});
		await store.adopt(snapshot);
		return { store, publicKey: keys.publicKey };
	}

	it('asks for everything since the last applied sequence and applies it', async () => {
		const { store } = await primedStore();
		const fetcher = fakeFetcher({
			[diffPath(0)]: [
				diff(1, entry({ domain: 'good.example' }, 'warned', 41), '2026-08-20T09:00:00Z'),
				diff(2, entry({ domain: 'new.example' }, 'establishing', 50), '2026-08-20T10:00:00Z'),
			],
		});

		const result = await syncDiff({ fetchJson: fetcher.fetchJson, store });

		expect(result).toEqual({
			ok: true,
			applied: 2,
			latestSeq: 2,
			asOf: '2026-08-20T10:00:00Z',
			gapDetected: false,
		});
		expect(fetcher.calls).toEqual(['/v1/diff?since=0']);
		expect(store.tier({ domain: 'good.example' })?.score).toBe(41);
		expect(store.tier({ domain: 'new.example' })?.tier).toBe('establishing');
	});

	it('advances the cursor, so a second sync asks only for what is new', async () => {
		const { store } = await primedStore();
		const fetcher = fakeFetcher({
			[diffPath(0)]: [diff(7, entry({ domain: 'good.example' }, 'warned', 41))],
			[diffPath(7)]: [],
		});
		await syncDiff({ fetchJson: fetcher.fetchJson, store });
		const second = await syncDiff({ fetchJson: fetcher.fetchJson, store });
		expect(second).toMatchObject({ ok: true, applied: 0, latestSeq: 7 });
		expect(fetcher.calls).toEqual(['/v1/diff?since=0', '/v1/diff?since=7']);
	});

	it('accepts the enveloped feed shape as well as a bare array', async () => {
		const { store } = await primedStore();
		const fetcher = fakeFetcher({
			[diffPath(0)]: { entries: [diff(3, entry({ domain: 'bad.example' }, 'warned', 30))] },
		});
		expect(await syncDiff({ fetchJson: fetcher.fetchJson, store })).toMatchObject({
			ok: true,
			applied: 1,
		});
		expect(store.tier({ domain: 'bad.example' })?.score).toBe(30);
	});

	it('honours an explicit `since`', async () => {
		const { store } = await primedStore();
		const fetcher = fakeFetcher({ [diffPath(12)]: [] });
		expect(await syncDiff({ fetchJson: fetcher.fetchJson, store, since: 12 })).toMatchObject({
			ok: true,
		});
		expect(fetcher.calls).toEqual(['/v1/diff?since=12']);
	});

	it('refuses to build a scored set out of unsigned diff lines alone', async () => {
		const fetcher = fakeFetcher({ [diffPath(0)]: [] });
		const result = await syncDiff({
			fetchJson: fetcher.fetchJson,
			store: new SnapshotStore({ allowUnsignedDiffs: true }),
		});
		expect(result).toEqual({ ok: false, errors: ['no verified snapshot to apply diffs to'] });
		expect(fetcher.calls).toEqual([]);
	});

	it('REFUSES the feed by default, without even sending the request', async () => {
		// Anyone who can answer /v1/diff — a compromised aggregator, a mirror,
		// a TLS-terminating proxy — can write this response. Nothing signs it.
		const { store } = await primedStore({ allowUnsignedDiffs: false });
		const fetcher = fakeFetcher({
			[diffPath(0)]: [diff(1, entry({ domain: 'bad.example' }, 'trusted', 99))],
		});

		const result = await syncDiff({ fetchJson: fetcher.fetchJson, store });

		expect(result).toMatchObject({ ok: false });
		if (result.ok) return;
		expect(result.errors[0]).toContain('allowUnsignedDiffs');
		expect(fetcher.calls).toEqual([]);
		expect(store.tier({ domain: 'bad.example' })).toMatchObject({ tier: 'flagged', score: 4 });
	});

	it('applies that same feed once the consumer has opted in', async () => {
		const { store } = await primedStore({ allowUnsignedDiffs: true });
		const fetcher = fakeFetcher({
			[diffPath(0)]: [diff(1, entry({ domain: 'bad.example' }, 'trusted', 99))],
		});
		expect(await syncDiff({ fetchJson: fetcher.fetchJson, store })).toMatchObject({ applied: 1 });
		expect(store.tier({ domain: 'bad.example' })?.tier).toBe('trusted');
	});

	it.each([1.5, -1, Number.NaN])(
		'refuses the cursor %p instead of querying ?since=it',
		async (since) => {
			const { store } = await primedStore();
			const fetcher = fakeFetcher({});
			const result = await syncDiff({ fetchJson: fetcher.fetchJson, store, since });
			expect(result).toMatchObject({ ok: false });
			if (result.ok) return;
			expect(result.errors[0]).toContain('non-negative integer');
			expect(fetcher.calls).toEqual([]);
		}
	);

	it('drops entries at or below the cursor the caller asked about', async () => {
		const { store } = await primedStore();
		// A server is free to answer with whatever it likes; `since` is the
		// client's question and the client holds it.
		const fetcher = fakeFetcher({
			[diffPath(5)]: [
				diff(3, entry({ domain: 'good.example' }, 'flagged', 1)),
				diff(5, entry({ domain: 'good.example' }, 'flagged', 2)),
				diff(6, entry({ domain: 'new.example' }, 'establishing', 50)),
			],
		});

		const result = await syncDiff({ fetchJson: fetcher.fetchJson, store, since: 5 });

		expect(result).toMatchObject({ ok: true, applied: 1, latestSeq: 6 });
		expect(store.tier({ domain: 'good.example' })?.score).toBe(88);
		expect(store.tier({ domain: 'new.example' })?.score).toBe(50);
	});

	it('reports a store refusal — an oversized feed — as a failed sync', async () => {
		const { snapshot, keys } = signedSnapshot(ENTRIES);
		const store = new SnapshotStore({
			publicKey: keys.publicKey,
			allowUnsignedDiffs: true,
			maxDiffEntries: 2,
		});
		await store.adopt(snapshot);
		const fetcher = fakeFetcher({
			[diffPath(0)]: [1, 2, 3].map((seq) =>
				diff(seq, entry({ domain: `s${seq}.example` }, 'warned', 30))
			),
		});

		const result = await syncDiff({ fetchJson: fetcher.fetchJson, store });

		expect(result).toMatchObject({ ok: false });
		if (result.ok) return;
		expect(result.errors[0]).toContain('maxDiffEntries=2');
		expect(store.latestSeq()).toBe(0);
	});

	it.each([
		['null', null],
		['a bare object', { seq: 1 }],
		['entries missing a sequence', [{ asOf: 'now', entry: ENTRIES[0] }]],
		['entries with a negative sequence', [{ seq: -1, asOf: 'now', entry: ENTRIES[0] }]],
		[
			'entries with an unknown tier',
			[{ seq: 1, asOf: 'now', entry: { ...ENTRIES[0], tier: 'x' } }],
		],
	])('rejects a feed that is %s, leaving the set untouched', async (_label, payload) => {
		const { store } = await primedStore();
		const result = await syncDiff({
			fetchJson: fakeFetcher({ [diffPath(0)]: payload }).fetchJson,
			store,
		});
		expect(result).toMatchObject({ ok: false });
		expect(store.tier({ domain: 'good.example' })?.score).toBe(88);
	});

	it('reports a transport failure', async () => {
		const { store } = await primedStore();
		const result = await syncDiff({
			fetchJson: () => Promise.reject(new Error('timeout')),
			store,
		});
		expect(result).toMatchObject({ ok: false });
	});

	describe('pruned-feed gap', () => {
		it('flags a cursor the feed has pruned past, and still applies the answer', async () => {
			// The registry keeps the newest DIFF_FEED_MAX_ROWS diff rows. A consumer
			// whose cursor predates the prune gets a valid answer that simply starts
			// higher up — every tier change in between is gone, and without this flag
			// the consumer would call itself current until the next snapshot.
			const { store } = await primedStore();
			const fetcher = fakeFetcher({
				[diffPath(9)]: [diff(500, entry({ domain: 'new.example' }, 'establishing', 50))],
			});

			const result = await syncDiff({ fetchJson: fetcher.fetchJson, store, since: 9 });

			expect(result).toMatchObject({ ok: true, applied: 1, gapDetected: true });
			expect(store.tier({ domain: 'new.example' })?.score).toBe(50);
		});

		it('does not flag a contiguous answer', async () => {
			const { store } = await primedStore();
			const fetcher = fakeFetcher({
				[diffPath(9)]: [
					diff(10, entry({ domain: 'good.example' }, 'warned', 41)),
					diff(11, entry({ domain: 'new.example' }, 'establishing', 50)),
				],
			});
			expect(await syncDiff({ fetchJson: fetcher.fetchJson, store, since: 9 })).toMatchObject({
				gapDetected: false,
			});
		});

		it('does not flag the first sync after a snapshot, whatever the feed starts at', async () => {
			// `since === 0` is a store holding a snapshot and no diffs. The snapshot
			// already accounts for the whole feed behind it, so a feed that opens at
			// seq 190_000 is the normal case and not a gap.
			const { store } = await primedStore();
			const fetcher = fakeFetcher({
				[diffPath(0)]: [diff(190_000, entry({ domain: 'good.example' }, 'warned', 41))],
			});
			expect(await syncDiff({ fetchJson: fetcher.fetchJson, store })).toMatchObject({
				ok: true,
				applied: 1,
				gapDetected: false,
			});
		});

		it('does not flag an empty answer — a drained feed is current, not pruned', async () => {
			const { store } = await primedStore();
			const fetcher = fakeFetcher({ [diffPath(9)]: [] });
			expect(await syncDiff({ fetchJson: fetcher.fetchJson, store, since: 9 })).toMatchObject({
				ok: true,
				applied: 0,
				gapDetected: false,
			});
		});

		it('reads the oldest fresh entry, not the first one the server listed', async () => {
			const { store } = await primedStore();
			const fetcher = fakeFetcher({
				[diffPath(9)]: [
					diff(40, entry({ domain: 'new.example' }, 'establishing', 50)),
					diff(10, entry({ domain: 'good.example' }, 'warned', 41)),
					diff(4, entry({ domain: 'bad.example' }, 'trusted', 99)),
				],
			});
			// seq 4 is at or below the cursor and is dropped; the oldest entry that
			// survives is 10, which is contiguous with since=9.
			expect(await syncDiff({ fetchJson: fetcher.fetchJson, store, since: 9 })).toMatchObject({
				applied: 2,
				gapDetected: false,
			});
			expect(store.tier({ domain: 'bad.example' })?.tier).toBe('flagged');
		});
	});
});
