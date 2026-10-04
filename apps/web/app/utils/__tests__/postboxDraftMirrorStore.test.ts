/**
 * Persistence for the composer's device draft mirror ("keep and ask").
 *
 * What these cases protect:
 *   - FAIL-SOFT, BUT HONEST. A write reports true only when it committed on a
 *     store that actually keeps data; the no-op driver and a throwing driver
 *     both report false, so a caller never drops its other copy on the strength
 *     of a write that went nowhere.
 *   - G1, NO SILENT LOSS. Every delete of a key the caller does not own goes
 *     through a conditional delete that re-checks the STORED value. A copy
 *     replaced between the caller's read and the delete survives; separately
 *     cloned but equal values still match; extra conditions (`alsoRequire`)
 *     are evaluated inside the conditional delete.
 *   - SCOPE. Listing and retention stay inside one mailbox's mirror prefix and
 *     never touch other mailboxes, legacy entries, or unrelated keys.
 *   - LEGACY. v1 tombstones are honoured; resolving a v1 entry narrows its old
 *     index.
 */
import { describe, expect, it, vi } from 'vitest';
import {
	MIRROR_CAP_PER_MAILBOX,
	MIRROR_RETENTION_MS,
	type LegacyMirrorEntry,
	type MirrorCopy,
	type MirrorFields,
} from '../postboxDraftMirror';
import {
	PostboxDraftMirrorStore,
	mirrorCopyKey,
	provisionalDraftKey,
} from '../postboxDraftMirrorStore';
import type { OfflineKvDriver } from '../postboxOfflineStore';

interface MemoryDriverOptions {
	/** Implement `deleteIf` (one atomic read-decide-delete). Default true. */
	transactional?: boolean;
	/** `persistent` flag the driver reports. Default true. */
	persistent?: boolean;
	/** Runs inside `deleteIf` before the read, standing in for a write that landed first. */
	beforeDeleteIf?: (key: string, map: Map<string, unknown>) => void;
}

type MemoryDriver = OfflineKvDriver & { map: Map<string, unknown>; inTransaction: boolean };

/**
 * In-memory stand-in for the IndexedDB driver. Values are structured-cloned on
 * the way in AND out, so every read hands back a fresh object exactly like
 * IndexedDB does, and identity comparison can never pass by accident.
 */
function memoryDriver(options: MemoryDriverOptions = {}): MemoryDriver {
	const map = new Map<string, unknown>();
	const driver: MemoryDriver = {
		map,
		inTransaction: false,
		persistent: options.persistent ?? true,
		async get<T>(key: string) {
			return (map.has(key) ? structuredClone(map.get(key)) : undefined) as T | undefined;
		},
		async set(key, value) {
			map.set(key, structuredClone(value));
		},
		async delete(key) {
			map.delete(key);
		},
		async keys() {
			return [...map.keys()];
		},
		async clear() {
			map.clear();
		},
	};
	if (options.transactional !== false) {
		driver.deleteIf = async (key, predicate) => {
			options.beforeDeleteIf?.(key, map);
			driver.inTransaction = true;
			try {
				const current = map.has(key) ? structuredClone(map.get(key)) : undefined;
				let approve = false;
				try {
					approve = predicate(current);
				} catch {
					approve = false;
				}
				if (approve) map.delete(key);
				return approve;
			} finally {
				driver.inTransaction = false;
			}
		};
	}
	return driver;
}

/** A driver whose every operation throws, like a broken or blocked backend. */
function throwingDriver(): OfflineKvDriver {
	const fail = async () => {
		throw new Error('IndexedDB transaction aborted');
	};
	return {
		persistent: true,
		get: fail,
		set: fail,
		delete: fail,
		keys: fail,
		clear: fail,
		deleteIf: fail,
	};
}

const NS = 'mbxA';
const OTHER_NS = 'mbxB';
const NOW = 1_800_000_000_000;

function fields(over: Partial<MirrorFields> = {}): MirrorFields {
	return {
		toAddresses: ['ines@northwind.studio'],
		ccAddresses: [],
		bccAddresses: [],
		subject: 'Invoice 4471',
		bodyHtml: '<p>Hi Ines,</p>',
		bodyBlocks: '[]',
		composerMode: 'simple',
		followUpRemindAt: null,
		...over,
	};
}

function copy(over: Partial<MirrorCopy> = {}): MirrorCopy {
	return {
		v: 2,
		fields: fields(),
		base: null,
		savedAt: NOW,
		draftId: 'd1',
		inReplyTo: null,
		...over,
	};
}

function legacyEntry(over: Partial<LegacyMirrorEntry> = {}): LegacyMirrorEntry {
	return {
		fields: {
			toAddresses: ['ines@northwind.studio'],
			ccAddresses: [],
			bccAddresses: [],
			subject: 'Invoice 4471',
			bodyHtml: '<p>Hi Ines,</p>',
			composerMode: 'simple',
		},
		savedAt: NOW,
		serverEditedAt: NOW - 1_000,
		...over,
	};
}

describe('PostboxDraftMirrorStore keys', () => {
	it('builds one colon-separated key per session slot, and a provisional draft key', () => {
		expect(mirrorCopyKey(NS, 'd1', 's1', 'live')).toBe('draft-mirror:v2:mbxA:d1:s1:live');
		expect(provisionalDraftKey('s1')).toBe('new-s1');
	});
});

describe('PostboxDraftMirrorStore.write', () => {
	it('reports true and stores the copy on a persistent driver', async () => {
		const driver = memoryDriver();
		const store = new PostboxDraftMirrorStore(driver);
		const key = mirrorCopyKey(NS, 'd1', 's1', 'live');

		expect(store.persistent).toBe(true);
		expect(await store.write(key, copy())).toBe(true);
		expect(driver.map.get(key)).toEqual(copy());
	});

	it('reports false on a non-persistent driver without writing', async () => {
		const driver = memoryDriver({ persistent: false });
		const set = vi.spyOn(driver, 'set');
		const store = new PostboxDraftMirrorStore(driver);

		expect(store.persistent).toBe(false);
		expect(await store.write(mirrorCopyKey(NS, 'd1', 's1', 'live'), copy())).toBe(false);
		expect(set).not.toHaveBeenCalled();
	});

	it('treats a driver that does not report `persistent` as persistent', async () => {
		const driver = memoryDriver();
		delete (driver as { persistent?: boolean }).persistent;
		expect(new PostboxDraftMirrorStore(driver).persistent).toBe(true);
	});

	it('reports false, without throwing, when the write fails', async () => {
		const store = new PostboxDraftMirrorStore(throwingDriver());
		expect(await store.write(mirrorCopyKey(NS, 'd1', 's1', 'live'), copy())).toBe(false);
	});

	it('reports a failed remove as false', async () => {
		const store = new PostboxDraftMirrorStore(throwingDriver());
		expect(await store.remove(mirrorCopyKey(NS, 'd1', 's1', 'live'))).toBe(false);
	});
});

describe('PostboxDraftMirrorStore.list', () => {
	async function seeded() {
		const driver = memoryDriver();
		const store = new PostboxDraftMirrorStore(driver);
		const put = (key: string, value: unknown) => driver.set(key, value);

		await put(mirrorCopyKey(NS, 'd1', 's1', 'live'), copy({ savedAt: 1 }));
		await put(mirrorCopyKey(NS, 'd1', 's2', 'pre-restore.b1'), copy({ savedAt: 2 }));
		await put(mirrorCopyKey(NS, 'd10', 's3', 'live'), copy({ savedAt: 3, draftId: 'd10' }));
		await put(mirrorCopyKey(NS, 'new-s4', 's4', 'live'), copy({ savedAt: 4, draftId: null }));
		// Another mailbox, and a mailbox whose id merely starts with ours.
		await put(mirrorCopyKey(OTHER_NS, 'd1', 's5', 'live'), copy());
		await put(mirrorCopyKey(`${NS}2`, 'd1', 's6', 'live'), copy());
		// Malformed values.
		await put(mirrorCopyKey(NS, 'd1', 's7', 'live'), { v: 1, savedAt: 5 });
		await put(mirrorCopyKey(NS, 'd1', 's8', 'live'), { v: 2, savedAt: 'yesterday' });
		await put(mirrorCopyKey(NS, 'd1', 's9', 'live'), 'not a copy');
		await put(mirrorCopyKey(NS, 'd1', 's10', 'live'), null);
		// Malformed keys: too few and too many segments.
		await put(`draft-mirror:v2:${NS}:d1:s11`, copy());
		await put(`draft-mirror:v2:${NS}:d1:s12:live:extra`, copy());
		// Neighbours that are not v2 copies.
		await put(`draft-mirror:${NS}:d1`, legacyEntry());
		await put(`outbox:${NS}:x`, copy());
		return { driver, store };
	}

	it('returns every valid copy in the mailbox, located, and nothing from elsewhere', async () => {
		const { store } = await seeded();
		const records = await store.list(NS);

		expect(records.map((r) => r.key).sort()).toEqual(
			[
				mirrorCopyKey(NS, 'd1', 's1', 'live'),
				mirrorCopyKey(NS, 'd1', 's2', 'pre-restore.b1'),
				mirrorCopyKey(NS, 'd10', 's3', 'live'),
				mirrorCopyKey(NS, 'new-s4', 's4', 'live'),
			].sort()
		);
		const backup = records.find((r) => r.sessionId === 's2');
		expect(backup).toMatchObject({ draftKey: 'd1', sessionId: 's2', slot: 'pre-restore.b1' });
		expect(backup?.copy.savedAt).toBe(2);
	});

	it('narrows to one draft key without matching a longer key that starts with it', async () => {
		const { store } = await seeded();
		const records = await store.list(NS, 'd1');
		expect(records.map((r) => r.sessionId).sort()).toEqual(['s1', 's2']);
	});

	it('returns nothing when the key listing fails', async () => {
		expect(await new PostboxDraftMirrorStore(throwingDriver()).list(NS)).toEqual([]);
	});

	it('skips a copy whose read fails and keeps the rest', async () => {
		const driver = memoryDriver();
		await driver.set(mirrorCopyKey(NS, 'd1', 's1', 'live'), copy());
		await driver.set(mirrorCopyKey(NS, 'd1', 's2', 'live'), copy());
		const get = driver.get.bind(driver);
		vi.spyOn(driver, 'get').mockImplementation(async <T>(key: string) => {
			if (key.includes(':s1:')) throw new Error('read failed');
			return get<T>(key);
		});
		const records = await new PostboxDraftMirrorStore(driver).list(NS);
		expect(records.map((r) => r.sessionId)).toEqual(['s2']);
	});
});

describe('PostboxDraftMirrorStore.removeIfUnchanged (G1)', () => {
	const key = mirrorCopyKey(NS, 'd1', 'other-session', 'live');

	it('deletes a copy that still holds the value the decision was based on', async () => {
		const driver = memoryDriver();
		const store = new PostboxDraftMirrorStore(driver);
		await store.write(key, copy());

		const [record] = await store.list(NS);
		expect(await store.removeIfUnchanged(key, record?.copy)).toBe(true);
		expect(driver.map.has(key)).toBe(false);
	});

	it('matches separately cloned equal objects, whatever their key order', async () => {
		const driver = memoryDriver();
		const store = new PostboxDraftMirrorStore(driver);
		await store.write(key, copy());

		// Rebuilt by hand, keys in another order, never the same object as stored.
		const expected = {
			inReplyTo: null,
			draftId: 'd1',
			savedAt: NOW,
			base: null,
			fields: { ...fields() },
			v: 2,
		};
		expect(await store.removeIfUnchanged(key, structuredClone(expected))).toBe(true);
		expect(driver.map.has(key)).toBe(false);
	});

	it('refuses, and keeps the newer copy, when the value was replaced between the scan and the delete', async () => {
		const newer = copy({
			fields: fields({ bodyHtml: '<p>Typed after the scan</p>' }),
			savedAt: NOW + 5,
		});
		const driver = memoryDriver({
			// The owning session writes its next snapshot after our scan read the
			// old one, but before our conditional delete runs.
			beforeDeleteIf: (k, map) => map.set(k, structuredClone(newer)),
		});
		const store = new PostboxDraftMirrorStore(driver);
		await store.write(key, copy());
		const [scanned] = await store.list(NS);

		expect(await store.removeIfUnchanged(key, scanned?.copy)).toBe(false);
		expect(driver.map.get(key)).toEqual(newer);
	});

	it('refuses a replacement written before the call too (stale read)', async () => {
		const driver = memoryDriver();
		const store = new PostboxDraftMirrorStore(driver);
		await store.write(key, copy());
		const [scanned] = await store.list(NS);
		const newer = copy({ savedAt: NOW + 1, fields: fields({ subject: 'Changed' }) });
		await store.write(key, newer);

		expect(await store.removeIfUnchanged(key, scanned?.copy)).toBe(false);
		expect(driver.map.get(key)).toEqual(newer);
	});

	it('refuses when the key is already gone', async () => {
		const store = new PostboxDraftMirrorStore(memoryDriver());
		expect(await store.removeIfUnchanged(key, copy())).toBe(false);
	});

	it('honours `alsoRequire`, and evaluates it inside the conditional delete', async () => {
		const driver = memoryDriver();
		const store = new PostboxDraftMirrorStore(driver);
		await store.write(key, copy());

		const seenInTransaction: boolean[] = [];
		const refuse = () => {
			seenInTransaction.push(driver.inTransaction);
			return false;
		};
		expect(await store.removeIfUnchanged(key, copy(), refuse)).toBe(false);
		expect(driver.map.has(key)).toBe(true);
		expect(seenInTransaction).toEqual([true]);

		expect(await store.removeIfUnchanged(key, copy(), () => true)).toBe(true);
		expect(driver.map.has(key)).toBe(false);
	});

	it('reports false, without throwing, when the conditional delete fails', async () => {
		const store = new PostboxDraftMirrorStore(throwingDriver());
		expect(await store.removeIfUnchanged(key, copy())).toBe(false);
	});

	describe('without a transactional driver (read-then-delete fallback)', () => {
		it('deletes an unchanged copy', async () => {
			const driver = memoryDriver({ transactional: false });
			const store = new PostboxDraftMirrorStore(driver);
			await store.write(key, copy());

			expect(driver.deleteIf).toBeUndefined();
			expect(await store.removeIfUnchanged(key, structuredClone(copy()))).toBe(true);
			expect(driver.map.has(key)).toBe(false);
		});

		it('refuses a replaced copy and an `alsoRequire` that says no', async () => {
			const driver = memoryDriver({ transactional: false });
			const store = new PostboxDraftMirrorStore(driver);
			await store.write(key, copy({ savedAt: NOW + 1 }));

			expect(await store.removeIfUnchanged(key, copy())).toBe(false);
			expect(await store.removeIfUnchanged(key, copy({ savedAt: NOW + 1 }), () => false)).toBe(
				false
			);
			expect(driver.map.has(key)).toBe(true);
		});
	});
});

describe('PostboxDraftMirrorStore.readLegacy', () => {
	const key = `draft-mirror:${NS}:d1`;
	const tomb = `draft-mirror-dead:${NS}:d1`;

	it('returns a valid v1 entry, located', async () => {
		const driver = memoryDriver();
		await driver.set(key, legacyEntry());
		const record = await new PostboxDraftMirrorStore(driver).readLegacy(NS, 'd1');
		expect(record).toEqual({ key, id: 'd1', entry: legacyEntry() });
		// Reading never removes it.
		expect(driver.map.has(key)).toBe(true);
	});

	it('drops a tombstoned entry together with its tombstone', async () => {
		const driver = memoryDriver();
		await driver.set(key, legacyEntry());
		await driver.set(tomb, { at: NOW });
		// Another composition's entry and tombstone are not affected.
		await driver.set(`draft-mirror:${NS}:d2`, legacyEntry());
		await driver.set(`draft-mirror-dead:${OTHER_NS}:d1`, { at: NOW });

		expect(await new PostboxDraftMirrorStore(driver).readLegacy(NS, 'd1')).toBeNull();
		expect(driver.map.has(key)).toBe(false);
		expect(driver.map.has(tomb)).toBe(false);
		expect(driver.map.has(`draft-mirror:${NS}:d2`)).toBe(true);
		expect(driver.map.has(`draft-mirror-dead:${OTHER_NS}:d1`)).toBe(true);
	});

	it('returns null for a missing or malformed entry', async () => {
		const driver = memoryDriver();
		const store = new PostboxDraftMirrorStore(driver);
		expect(await store.readLegacy(NS, 'd1')).toBeNull();

		await driver.set(key, { savedAt: 'yesterday', fields: {} });
		expect(await store.readLegacy(NS, 'd1')).toBeNull();
		await driver.set(key, { savedAt: NOW });
		expect(await store.readLegacy(NS, 'd1')).toBeNull();
	});

	it('reads the provisional reply key of a fresh reply', async () => {
		const driver = memoryDriver();
		await driver.set(`draft-mirror:${NS}:new-reply:m1`, legacyEntry());
		const record = await new PostboxDraftMirrorStore(driver).readLegacy(NS, 'new-reply:m1');
		expect(record?.key).toBe(`draft-mirror:${NS}:new-reply:m1`);
	});
});

describe('PostboxDraftMirrorStore.removeLegacy', () => {
	const indexKey = `draft-mirror-index:${NS}`;

	it('removes the resolved entry and narrows the old index', async () => {
		const driver = memoryDriver();
		const store = new PostboxDraftMirrorStore(driver);
		await driver.set(`draft-mirror:${NS}:d1`, legacyEntry());
		await driver.set(indexKey, ['d0', 'd1', 'd2']);
		await driver.set(`draft-mirror-index:${OTHER_NS}`, ['d1']);

		const record = await store.readLegacy(NS, 'd1');
		expect(record).not.toBeNull();
		expect(await store.removeLegacy(record!)).toBe(true);
		expect(driver.map.has(`draft-mirror:${NS}:d1`)).toBe(false);
		expect(driver.map.get(indexKey)).toEqual(['d0', 'd2']);
		expect(driver.map.get(`draft-mirror-index:${OTHER_NS}`)).toEqual(['d1']);
	});

	it('narrows the index for an id that itself contains a colon', async () => {
		const driver = memoryDriver();
		const store = new PostboxDraftMirrorStore(driver);
		await driver.set(`draft-mirror:${NS}:new-reply:m1`, legacyEntry());
		await driver.set(indexKey, ['new-reply:m1', 'new']);

		const record = await store.readLegacy(NS, 'new-reply:m1');
		expect(await store.removeLegacy(record!)).toBe(true);
		expect(driver.map.get(indexKey)).toEqual(['new']);
	});

	it('keeps the entry, and the index, when the entry changed since it was read', async () => {
		const driver = memoryDriver();
		const store = new PostboxDraftMirrorStore(driver);
		await driver.set(`draft-mirror:${NS}:d1`, legacyEntry());
		await driver.set(indexKey, ['d1']);
		const record = await store.readLegacy(NS, 'd1');
		await driver.set(`draft-mirror:${NS}:d1`, legacyEntry({ savedAt: NOW + 10 }));

		expect(await store.removeLegacy(record!)).toBe(false);
		expect(driver.map.has(`draft-mirror:${NS}:d1`)).toBe(true);
		expect(driver.map.get(indexKey)).toEqual(['d1']);
	});

	it('removes the entry even when there is no index', async () => {
		const driver = memoryDriver();
		const store = new PostboxDraftMirrorStore(driver);
		await driver.set(`draft-mirror:${NS}:d1`, legacyEntry());
		const record = await store.readLegacy(NS, 'd1');

		expect(await store.removeLegacy(record!)).toBe(true);
		expect(driver.map.has(indexKey)).toBe(false);
	});
});

describe('PostboxDraftMirrorStore.sweep', () => {
	const DAY = 24 * 60 * 60 * 1000;
	const never = () => false;

	it('expires copies older than the retention window and keeps the one at the boundary', async () => {
		const driver = memoryDriver();
		const store = new PostboxDraftMirrorStore(driver);
		const old = mirrorCopyKey(NS, 'd1', 's1', 'live');
		const boundary = mirrorCopyKey(NS, 'd2', 's2', 'live');
		const fresh = mirrorCopyKey(NS, 'd3', 's3', 'live');
		await store.write(old, copy({ savedAt: NOW - 15 * DAY }));
		await store.write(boundary, copy({ savedAt: NOW - MIRROR_RETENTION_MS }));
		await store.write(fresh, copy({ savedAt: NOW - DAY }));

		await store.sweep(NS, NOW, never);
		expect([...driver.map.keys()].sort()).toEqual([boundary, fresh].sort());
	});

	it(`expires the oldest copies beyond ${MIRROR_CAP_PER_MAILBOX} per mailbox`, async () => {
		const driver = memoryDriver();
		const store = new PostboxDraftMirrorStore(driver);
		const keyOf = (i: number) => mirrorCopyKey(NS, `d${i}`, `s${i}`, 'live');
		// 33 fresh copies, i = 0 newest … 32 oldest (all well inside retention).
		for (let i = 0; i < MIRROR_CAP_PER_MAILBOX + 3; i++) {
			await store.write(keyOf(i), copy({ savedAt: NOW - i * 1_000 }));
		}

		await store.sweep(NS, NOW, never);
		const kept = (await store.list(NS)).map((r) => r.key);
		expect(kept).toHaveLength(MIRROR_CAP_PER_MAILBOX);
		for (let i = 0; i < MIRROR_CAP_PER_MAILBOX; i++) expect(kept).toContain(keyOf(i));
		for (let i = MIRROR_CAP_PER_MAILBOX; i < MIRROR_CAP_PER_MAILBOX + 3; i++) {
			expect(driver.map.has(keyOf(i))).toBe(false);
		}
	});

	it('never touches skipped copies, other mailboxes, legacy entries or non-mirror keys', async () => {
		const driver = memoryDriver();
		const store = new PostboxDraftMirrorStore(driver);
		const ancient = NOW - 60 * DAY;
		const skipped = mirrorCopyKey(NS, 'd1', 'live-session', 'live');
		const expired = mirrorCopyKey(NS, 'd2', 's2', 'live');
		const otherMailbox = mirrorCopyKey(OTHER_NS, 'd3', 's3', 'live');
		await store.write(skipped, copy({ savedAt: ancient }));
		await store.write(expired, copy({ savedAt: ancient }));
		await store.write(otherMailbox, copy({ savedAt: ancient }));
		await driver.set(`draft-mirror:${NS}:d4`, legacyEntry({ savedAt: ancient }));
		await driver.set(`outbox:${NS}:q1`, { queuedAt: ancient, savedAt: ancient });
		await driver.set(`body:${NS}:m1`, { srcdoc: '<p>x</p>', cachedAt: ancient });

		await store.sweep(NS, NOW, (record) => record.sessionId === 'live-session');
		expect(driver.map.has(expired)).toBe(false);
		expect([...driver.map.keys()].sort()).toEqual(
			[skipped, otherMailbox, `draft-mirror:${NS}:d4`, `outbox:${NS}:q1`, `body:${NS}:m1`].sort()
		);
	});

	it('does not count skipped copies against the cap', async () => {
		const driver = memoryDriver();
		const store = new PostboxDraftMirrorStore(driver);
		// Five newest copies are skipped (a live session's); 30 more fill the cap.
		for (let i = 0; i < MIRROR_CAP_PER_MAILBOX + 5; i++) {
			await store.write(
				mirrorCopyKey(NS, `d${i}`, i < 5 ? 'live' : `s${i}`, 'live'),
				copy({ savedAt: NOW - i })
			);
		}

		await store.sweep(NS, NOW, (record) => record.sessionId === 'live');
		expect(await store.list(NS)).toHaveLength(MIRROR_CAP_PER_MAILBOX + 5);
	});

	it('keeps an expired copy that was replaced between the scan and its delete', async () => {
		const key = mirrorCopyKey(NS, 'd1', 's1', 'live');
		const replacement = copy({ savedAt: NOW, fields: fields({ subject: 'Written again' }) });
		const driver = memoryDriver({
			beforeDeleteIf: (k, map) => map.set(k, structuredClone(replacement)),
		});
		const store = new PostboxDraftMirrorStore(driver);
		await store.write(key, copy({ savedAt: NOW - 30 * DAY }));

		await store.sweep(NS, NOW, never);
		expect(driver.map.get(key)).toEqual(replacement);
	});
});
