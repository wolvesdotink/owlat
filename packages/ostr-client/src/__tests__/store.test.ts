/**
 * The local scored set: lookups, the diff feed applied on top of a snapshot,
 * and the bounds that keep both from growing without limit.
 *
 * The trust-boundary half of this class — signature verification on adopt and
 * hydrate, and the refusal to take unsigned diffs on the caller's word — lives
 * in `store.trust.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { createMemoryPersistence, SnapshotStore, type SnapshotStoreOptions } from '../store.js';
import { AS_OF, diff, entry, HEAD, signedSnapshot } from './fixtures.js';

const ENTRIES = [
	entry({ domain: 'good.example' }, 'trusted', 88),
	entry({ domain: 'bad.example' }, 'flagged', 4),
	entry({ ip: '192.0.2.7' }, 'warned', 31),
	entry({ ip: '2001:db8::1' }, 'trusted', 76),
	entry({ domain: 'shared.example', ip: '192.0.2.9' }, 'establishing', 52),
];

/** A store holding the fixture snapshot. Diffs are opted into by default here. */
async function loadedStore(options: SnapshotStoreOptions = {}): Promise<SnapshotStore> {
	const { snapshot } = signedSnapshot(ENTRIES);
	const store = new SnapshotStore({ allowUnsignedDiffs: true, ...options });
	await store.adopt(snapshot);
	return store;
}

describe('SnapshotStore lookups', () => {
	it('finds a domain, an IPv4 and an IPv6 subject', async () => {
		const store = await loadedStore();
		await store.persist();
		expect(store.tier({ domain: 'good.example' })?.score).toBe(88);
		expect(store.tier({ ip: '192.0.2.7' })?.tier).toBe('warned');
		expect(store.tier({ ip: '2001:db8::1' })?.score).toBe(76);
	});

	it('matches whatever spelling the caller has', async () => {
		const store = await loadedStore();
		expect(store.tier({ domain: 'GOOD.example.' })?.score).toBe(88);
		expect(store.tier({ ip: '2001:0DB8:0000:0000:0000:0000:0000:0001' })?.score).toBe(76);
	});

	it('returns null for a subject the snapshot does not score', async () => {
		const store = await loadedStore();
		expect(store.tier({ domain: 'unknown.example' })).toBeNull();
		expect(store.tier({})).toBeNull();
	});

	it('keeps the (ip, domain) pair separate from the domain, then falls back to it', async () => {
		const store = await loadedStore();
		// The pair is its own subject in the policy (plan D2)...
		expect(store.tier({ domain: 'shared.example', ip: '192.0.2.9' })?.score).toBe(52);
		// ...and asking for the bare domain does not silently answer with it.
		expect(store.tier({ domain: 'shared.example' })).toBeNull();
		// A caller that knows both falls back to the domain when only it is scored.
		expect(store.tier({ domain: 'good.example', ip: '198.51.100.4' })?.score).toBe(88);
	});

	it('reports the snapshot`s asOf and policy for an entry it came from', async () => {
		const store = await loadedStore();
		expect(store.lookup({ domain: 'good.example' })).toMatchObject({ asOf: AS_OF, seq: null });
		expect(store.policy()).toBe('ostr-policy-v1');
		expect(store.size()).toBe(ENTRIES.length);
	});

	it('exposes the as-of head set, and the oldest head timestamp of §8.1', async () => {
		const older = { ...HEAD, logId: 'older.example', timestamp: '2026-08-19T06:00:00Z' };
		const { snapshot } = signedSnapshot(ENTRIES);
		const store = new SnapshotStore();
		await store.adopt({ ...snapshot, heads: [HEAD, older] });
		expect(store.heads()).toHaveLength(2);
		// The oldest, because that is the instant every trusted log has been
		// accounted for up to; the newest would overstate coverage.
		expect(store.headsAsOf()).toBe('2026-08-19T06:00:00Z');
	});

	it('has nothing to report before a snapshot is loaded', () => {
		const store = new SnapshotStore();
		expect(store.heads()).toEqual([]);
		expect(store.headsAsOf()).toBeNull();
		expect(store.policy()).toBeNull();
		expect(store.asOf()).toBeNull();
		expect(store.latestSeq()).toBe(0);
		expect(store.size()).toBe(0);
	});

	it('orders head timestamps it cannot parse without throwing', async () => {
		const { snapshot } = signedSnapshot(ENTRIES);
		const store = new SnapshotStore();
		await store.adopt({
			...snapshot,
			heads: [
				{ ...HEAD, logId: 'b.example', timestamp: 'not-a-date-b' },
				{ ...HEAD, logId: 'a.example', timestamp: 'not-a-date-a' },
			],
		});
		expect(store.headsAsOf()).toBe('not-a-date-a');
	});
});

describe('SnapshotStore diffs', () => {
	it('applies entries in sequence order and reports the count', async () => {
		const store = await loadedStore();
		const applied = await store.applyDiffs([
			diff(2, entry({ domain: 'good.example' }, 'warned', 40), '2026-08-20T08:00:00Z'),
			diff(1, entry({ domain: 'good.example' }, 'flagged', 2), '2026-08-20T07:00:00Z'),
		]);
		expect(applied).toBe(2);
		// Sequence 2 is the later fact, whichever order the feed arrived in.
		expect(store.tier({ domain: 'good.example' })).toMatchObject({ tier: 'warned', score: 40 });
		expect(store.latestSeq()).toBe(2);
		expect(store.asOf()).toBe('2026-08-20T08:00:00Z');
	});

	it('adds a subject the snapshot never scored', async () => {
		const store = await loadedStore();
		await store.applyDiffs([diff(1, entry({ domain: 'new.example' }, 'establishing', 55))]);
		expect(store.tier({ domain: 'new.example' })?.score).toBe(55);
		expect(store.size()).toBe(ENTRIES.length + 1);
	});

	it('ignores entries at or below the sequence already applied', async () => {
		const store = await loadedStore();
		await store.applyDiffs([diff(5, entry({ domain: 'good.example' }, 'warned', 40))]);
		const applied = await store.applyDiffs([
			diff(5, entry({ domain: 'good.example' }, 'flagged', 1)),
			diff(3, entry({ domain: 'good.example' }, 'flagged', 1)),
		]);
		expect(applied).toBe(0);
		expect(store.tier({ domain: 'good.example' })?.score).toBe(40);
	});

	it('marks a diff-updated entry with the sequence that set it', async () => {
		const store = await loadedStore();
		await store.applyDiffs([diff(3, entry({ domain: 'good.example' }, 'flagged', 2))]);
		expect(store.lookup({ domain: 'good.example' })?.seq).toBe(3);
		expect(store.lookup({ domain: 'bad.example' })?.seq).toBeNull();
	});

	it('drops applied diffs when a newer snapshot is adopted', async () => {
		const store = await loadedStore();
		await store.applyDiffs([diff(9, entry({ domain: 'good.example' }, 'flagged', 1))]);
		const { snapshot } = signedSnapshot([entry({ domain: 'good.example' }, 'trusted', 91)], {
			asOf: '2026-08-21T06:00:00Z',
		});
		await store.adopt(snapshot);
		expect(store.latestSeq()).toBe(0);
		expect(store.tier({ domain: 'good.example' })?.score).toBe(91);
		expect(store.asOf()).toBe('2026-08-21T06:00:00Z');
	});

	it('refuses to apply diffs with no snapshot underneath them', async () => {
		const store = new SnapshotStore({ allowUnsignedDiffs: true });
		await expect(
			store.applyDiffs([diff(1, entry({ domain: 'x.example' }, 'trusted', 90))])
		).rejects.toThrow(/no snapshot/);
	});

	it('bumps the revision on every change, so a cache in front can see it', async () => {
		const store = await loadedStore();
		const adopted = store.revision();
		expect(await store.applyDiffs([])).toBe(0);
		// Nothing changed, so nothing to invalidate.
		expect(store.revision()).toBe(adopted);
		await store.applyDiffs([diff(1, entry({ domain: 'good.example' }, 'flagged', 1))]);
		expect(store.revision()).toBeGreaterThan(adopted);
	});
});

describe('SnapshotStore diff bounds', () => {
	/** Distinct subjects, so nothing compacts away. */
	function feed(count: number, from = 1): ReturnType<typeof diff>[] {
		return Array.from({ length: count }, (_unused, offset) =>
			diff(from + offset, entry({ domain: `s${from + offset}.example` }, 'warned', 30))
		);
	}

	it('compacts superseded entries for one subject down to the newest', async () => {
		const persistence = createMemoryPersistence();
		const store = await loadedStore({ persistence });
		await store.applyDiffs(
			Array.from({ length: 50 }, (_unused, index) =>
				diff(index + 1, entry({ domain: 'good.example' }, 'warned', 30 + index))
			)
		);
		expect(store.tier({ domain: 'good.example' })?.score).toBe(79);
		// The cursor and the newest asOf survive the collapse, which is all the
		// superseded entries were carrying.
		expect(store.latestSeq()).toBe(50);
		// One subject, one held entry — neither the array nor the file the
		// store re-serializes on every persist grows with the feed.
		const persisted = JSON.parse((await persistence.load()) ?? '') as { diffs: unknown[] };
		expect(persisted.diffs).toHaveLength(1);
	});

	it('refuses a feed larger than the store is willing to hold', async () => {
		const store = await loadedStore({ maxDiffEntries: 10 });
		await expect(store.applyDiffs(feed(11))).rejects.toThrow(/maxDiffEntries=10/);
		expect(store.latestSeq()).toBe(0);
		expect(store.tier({ domain: 's1.example' })).toBeNull();
	});

	it('holds a diff naming no scoreable subject for the cursor, and nothing else', async () => {
		const store = await loadedStore();
		// Structurally a diff entry, but the subject is not a name anything can
		// be looked up by. It must not become an index entry, and it must not
		// accumulate either.
		const unusable = entry({ domain: 'not a domain' }, 'trusted', 90);
		expect(await store.applyDiffs([diff(1, unusable), diff(2, unusable)])).toBe(2);
		expect(store.size()).toBe(ENTRIES.length);
		expect(store.latestSeq()).toBe(2);
		expect(store.tier({ domain: 'not a domain' })).toBeNull();
	});

	it('refuses a feed that would push the held set over the cap', async () => {
		const store = await loadedStore({ maxDiffEntries: 10 });
		expect(await store.applyDiffs(feed(6))).toBe(6);
		await expect(store.applyDiffs(feed(6, 100))).rejects.toThrow(/over maxDiffEntries=10/);
		// The refusal leaves the set exactly as it was.
		expect(store.latestSeq()).toBe(6);
		expect(store.tier({ domain: 's100.example' })).toBeNull();
	});
});
