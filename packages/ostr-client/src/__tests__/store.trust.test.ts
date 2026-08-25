/**
 * The store's trust boundary, tested from the attacker's side.
 *
 * Three claims, each with a test that would pass just as well if the code did
 * nothing — so each is written as "the forged thing is offered, and the scored
 * set does not move":
 *
 *  1. a snapshot enters the set only if its signature verifies, whichever door
 *     it arrives through (`adopt`, the network, or the local file);
 *  2. a persisted document's *diffs* are not signed by anything, so with a key
 *     configured they are dropped on hydrate rather than replayed; and
 *  3. an unsigned diff feed is refused entirely unless the consumer opted in.
 */

import { generateEd25519KeyPair } from '@owlat/ostr-core';
import { describe, expect, it } from 'vitest';
import { createMemoryPersistence, SnapshotStore } from '../store.js';
import { diff, entry, signedSnapshot } from './fixtures.js';

const ENTRIES = [
	entry({ domain: 'good.example' }, 'trusted', 88),
	entry({ domain: 'bad.example' }, 'flagged', 4),
];

describe('SnapshotStore.adopt verifies', () => {
	it('refuses a forged snapshot on a keyed store and keeps the previous set', async () => {
		const { snapshot, keys } = signedSnapshot(ENTRIES);
		const store = new SnapshotStore({ publicKey: keys.publicKey });
		expect(await store.adopt(snapshot)).toEqual({ ok: true, entries: 2 });

		const forged = { ...snapshot, entries: [entry({ domain: 'bad.example' }, 'trusted', 99)] };
		expect(await store.adopt(forged)).toEqual({
			ok: false,
			errors: ['snapshot signature did not verify'],
		});
		// The flagged sender is still flagged: adopt() is the choke point, so a
		// caller that skips syncSnapshot gains nothing.
		expect(store.tier({ domain: 'bad.example' })?.score).toBe(4);
		expect(store.tier({ domain: 'bad.example' })?.tier).toBe('flagged');
	});

	it('refuses a snapshot signed by a key that is not the configured one', async () => {
		const { snapshot } = signedSnapshot(ENTRIES);
		const store = new SnapshotStore({ publicKey: generateEd25519KeyPair().publicKey });
		expect(await store.adopt(snapshot)).toMatchObject({ ok: false });
		expect(store.snapshot()).toBeNull();
	});

	it('takes the caller`s word when no key is configured, and says so', async () => {
		const { snapshot } = signedSnapshot(ENTRIES);
		const store = new SnapshotStore();
		expect(await store.adopt({ ...snapshot, sig: 'ed25519:bm90LWEtc2lnbmF0dXJl' })).toMatchObject({
			ok: true,
		});
		expect(store.verifiesSnapshots()).toBe(false);
	});
});

describe('SnapshotStore persistence', () => {
	it('round-trips the snapshot, and re-syncs the diffs rather than replaying them', async () => {
		const { snapshot, keys } = signedSnapshot(ENTRIES);
		const persistence = createMemoryPersistence();
		const first = new SnapshotStore({
			persistence,
			publicKey: keys.publicKey,
			allowUnsignedDiffs: true,
		});
		await first.adopt(snapshot);
		await first.applyDiffs([diff(4, entry({ domain: 'bad.example' }, 'warned', 35))]);

		const second = new SnapshotStore({
			persistence,
			publicKey: keys.publicKey,
			allowUnsignedDiffs: true,
		});
		const result = await second.hydrate();

		// The signed half survives the restart intact...
		expect(result).toMatchObject({ status: 'loaded', entries: ENTRIES.length, droppedDiffs: 1 });
		expect(second.tier({ domain: 'good.example' })?.score).toBe(88);
		// ...and the unsigned half does not: the entry reverts to the snapshot
		// and the cursor restarts, so `syncDiff` fetches it again from the feed.
		expect(second.tier({ domain: 'bad.example' })?.score).toBe(4);
		expect(second.latestSeq()).toBe(0);
	});

	it('REFUSES an unsigned diff appended to the local file by hand', async () => {
		const { snapshot, keys } = signedSnapshot(ENTRIES);
		const persistence = createMemoryPersistence();
		const writer = new SnapshotStore({ persistence, publicKey: keys.publicKey });
		await writer.adopt(snapshot);

		// Anyone who can write the file can append a line to `diffs`; nothing
		// in the v1 format signs one. Editing the *snapshot* is caught by the
		// signature, and this is the hole that would otherwise be left open
		// right next to it.
		const document = JSON.parse((await persistence.load()) ?? '') as {
			diffs: unknown[];
		};
		document.diffs = [diff(1, entry({ domain: 'bad.example' }, 'trusted', 99))];
		const edited = createMemoryPersistence(JSON.stringify(document));

		const store = new SnapshotStore({
			persistence: edited,
			publicKey: keys.publicKey,
			allowUnsignedDiffs: true,
		});
		expect(await store.hydrate()).toMatchObject({ status: 'loaded', droppedDiffs: 1 });
		expect(store.tier({ domain: 'bad.example' })).toMatchObject({ tier: 'flagged', score: 4 });
	});

	it('replays persisted diffs only for a store that trusts its disk already', async () => {
		const { snapshot } = signedSnapshot(ENTRIES);
		const persistence = createMemoryPersistence();
		const writer = new SnapshotStore({ persistence, allowUnsignedDiffs: true });
		await writer.adopt(snapshot);
		await writer.applyDiffs([diff(2, entry({ domain: 'bad.example' }, 'warned', 35))]);

		// No public key: this store cannot verify the snapshot either, so the
		// diffs are no weaker than what they sit on.
		const store = new SnapshotStore({ persistence, allowUnsignedDiffs: true });
		expect(await store.hydrate()).toMatchObject({ status: 'loaded', droppedDiffs: 0 });
		expect(store.tier({ domain: 'bad.example' })?.score).toBe(35);
		expect(store.latestSeq()).toBe(2);
	});

	it('reports an empty store when nothing has been persisted', async () => {
		const store = new SnapshotStore({ persistence: createMemoryPersistence() });
		expect(await store.hydrate()).toEqual({ status: 'empty' });
	});

	it('rejects a persisted file that has been edited, rather than trusting the disk', async () => {
		const { snapshot, keys } = signedSnapshot(ENTRIES);
		const persistence = createMemoryPersistence();
		const writer = new SnapshotStore({ persistence });
		await writer.adopt(snapshot);

		const text = (await persistence.load()) as string;
		const tampered = text.replace('"score":4', '"score":99');
		expect(tampered).not.toBe(text);
		const edited = createMemoryPersistence(tampered);

		const store = new SnapshotStore({ persistence: edited, publicKey: keys.publicKey });
		expect(await store.hydrate()).toMatchObject({ status: 'rejected' });
		expect(store.snapshot()).toBeNull();
		expect(store.tier({ domain: 'bad.example' })).toBeNull();
	});

	it('rejects a snapshot signed by someone else', async () => {
		const { snapshot } = signedSnapshot(ENTRIES);
		const persistence = createMemoryPersistence();
		await new SnapshotStore({ persistence }).adopt(snapshot);
		const store = new SnapshotStore({
			persistence,
			publicKey: generateEd25519KeyPair().publicKey,
		});
		expect(await store.hydrate()).toMatchObject({ status: 'rejected' });
	});

	it.each(['', 'not json', '{}', '{"v":1}', '{"v":2,"snapshot":{},"diffs":[]}'])(
		'rejects the persisted payload %p',
		async (text) => {
			const store = new SnapshotStore({ persistence: createMemoryPersistence(text) });
			const result = await store.hydrate();
			expect(result.status === 'empty' || result.status === 'rejected').toBe(true);
			expect(store.snapshot()).toBeNull();
		}
	);

	it('reports a failing adapter instead of throwing through the lookup path', async () => {
		const store = new SnapshotStore({
			persistence: {
				load: () => Promise.reject(new Error('disk on fire')),
				save: () => Promise.resolve(),
			},
		});
		expect(await store.hydrate()).toMatchObject({
			status: 'rejected',
			errors: ['load failed: disk on fire'],
		});
	});

	it('works with no persistence at all', async () => {
		const { snapshot } = signedSnapshot(ENTRIES);
		const store = new SnapshotStore();
		await store.adopt(snapshot);
		expect(await store.hydrate()).toEqual({ status: 'empty' });
		expect(store.tier({ domain: 'good.example' })?.score).toBe(88);
	});
});

describe('unsigned diff entries are opt-in', () => {
	async function keyedStore(allowUnsignedDiffs: boolean): Promise<SnapshotStore> {
		const { snapshot, keys } = signedSnapshot(ENTRIES);
		const store = new SnapshotStore({ publicKey: keys.publicKey, allowUnsignedDiffs });
		await store.adopt(snapshot);
		return store;
	}

	it('refuses a feed that would flip a flagged subject to trusted', async () => {
		const store = await keyedStore(false);
		expect(store.acceptsUnsignedDiffs()).toBe(false);
		await expect(
			store.applyDiffs([diff(1, entry({ domain: 'bad.example' }, 'trusted', 99))])
		).rejects.toThrow(/unsigned diff entries refused/);
		expect(store.tier({ domain: 'bad.example' })).toMatchObject({ tier: 'flagged', score: 4 });
	});

	it('applies the same feed once the consumer has opted in', async () => {
		const store = await keyedStore(true);
		expect(await store.applyDiffs([diff(1, entry({ domain: 'bad.example' }, 'trusted', 99))])).toBe(
			1
		);
		expect(store.tier({ domain: 'bad.example' })?.tier).toBe('trusted');
	});
});
