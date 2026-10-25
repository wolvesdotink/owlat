/**
 * The device copy of editor drafts (`editorDraftStore.ts`): only well-formed,
 * young copies are handed back, a delete names the exact copies it may take
 * (never a newer one, whatever its timestamp), and writes to one key land in
 * the order they were asked for. The conditional delete also runs against
 * `fake-indexeddb`, in one real transaction.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { reactive } from 'vue';
import { createIndexedDbDriver, type OfflineKvDriver } from '../postboxOfflineKvDriver';
import {
	EDITOR_DRAFT_MAX_AGE_MS,
	createEditorDraftStore,
	editorDraftKey,
	editorDraftScope,
	editorDraftToken,
	type EditorDraftCopy,
} from '../editorDraftStore';

function memoryDriver(persistent = true): OfflineKvDriver & { data: Map<string, unknown> } {
	const data = new Map<string, unknown>();
	return {
		data,
		persistent,
		get: async <T>(key: string) =>
			(data.has(key) ? structuredClone(data.get(key)) : undefined) as T,
		// Like IndexedDB: a Vue proxy cannot be cloned in.
		set: async (key, value) => {
			data.set(key, structuredClone(value));
		},
		delete: async (key) => {
			data.delete(key);
		},
		keys: async () => [...data.keys()],
		clear: async () => data.clear(),
		deleteIf: async (key, predicate) => {
			if (!predicate(structuredClone(data.get(key)))) return false;
			data.delete(key);
			return true;
		},
	};
}

/** A promise the test settles by hand. */
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

const SCOPE = editorDraftScope({
	userId: 'user_1',
	organizationId: 'org_1',
	kind: 'campaign',
	id: 'cmp_1',
});
const KEY = editorDraftKey(SCOPE, 'tab-a.1');
const isText = (data: unknown): data is { text: string } =>
	typeof (data as { text?: unknown } | null)?.text === 'string';
const copy = (
	over: Partial<EditorDraftCopy<{ text: string }>> = {}
): EditorDraftCopy<{
	text: string;
}> => ({
	v: 2,
	token: 'tab-a.1#1',
	seq: 1,
	savedAt: 1_000,
	base: 7,
	data: { text: 'kept' },
	...over,
});

describe('editorDraftStore', () => {
	it('namespaces keys by person, workspace, kind, draft and editor', () => {
		expect(KEY).toBe('editor-draft:v1:user_1:org_1:campaign:cmp_1:tab-a.1');
	});

	it("lists every editor's copy of one draft, newest first, and nothing else", async () => {
		const driver = memoryDriver();
		const store = createEditorDraftStore(driver);
		const other = editorDraftScope({
			userId: 'user_1',
			organizationId: 'org_1',
			kind: 'campaign',
			id: 'cmp_10',
		});
		await store.write(KEY, copy({ savedAt: 1_000 }));
		await store.write(
			editorDraftKey(SCOPE, 'tab-b.1'),
			copy({ token: 'tab-b.1#1', savedAt: 3_000 })
		);
		await store.write(editorDraftKey(other, 'tab-a.1'), copy({ savedAt: 2_000 }));
		driver.data.set(editorDraftKey(SCOPE, 'tab-c.1'), { v: 2, junk: true });

		const found = await store.list(SCOPE, isText, 4_000);
		expect(found.map((f) => [f.writerId, f.token, f.savedAt])).toEqual([
			['tab-b.1', 'tab-b.1#1', 3_000],
			['tab-a.1', 'tab-a.1#1', 1_000],
		]);
		expect(driver.data.has(editorDraftKey(SCOPE, 'tab-c.1'))).toBe(false);
	});

	it('stores reactive state and reads it back', async () => {
		const store = createEditorDraftStore(memoryDriver());
		const data = reactive({ text: 'kept' });
		expect(await store.write(KEY, copy({ data }))).toBe(true);
		expect(await store.read(KEY, isText, 2_000)).toMatchObject({
			token: 'tab-a.1#1',
			base: 7,
			data: { text: 'kept' },
			legacy: false,
		});
	});

	it('reads a copy from before tokens, naming it by its content, its base untrusted', async () => {
		const driver = memoryDriver();
		const store = createEditorDraftStore(driver);
		const legacy = { v: 1, savedAt: 1_000, base: 7, data: { text: 'older build' } };
		driver.data.set(KEY, legacy);
		const found = await store.read(KEY, isText, 2_000);
		expect(found).toMatchObject({ legacy: true, data: { text: 'older build' } });
		expect(found?.token).toBe(editorDraftToken(legacy));
		// Another legacy copy at the same time is another copy.
		expect(editorDraftToken({ ...legacy, data: { text: 'other' } })).not.toBe(found?.token);
		expect(await store.removeIf(KEY, [found!.token])).toBe(true);
		expect(driver.data.has(KEY)).toBe(false);
	});

	it('drops a malformed, foreign-shaped or expired copy on read', async () => {
		const driver = memoryDriver();
		const store = createEditorDraftStore(driver);
		driver.data.set(KEY, { v: 2, junk: true });
		expect(await store.read(KEY, isText)).toBeNull();
		expect(driver.data.has(KEY)).toBe(false);

		driver.data.set(KEY, copy({ data: { other: 1 } as never }));
		expect(await store.read(KEY, isText)).toBeNull();
		expect(driver.data.has(KEY)).toBe(false);

		driver.data.set(KEY, copy());
		expect(await store.read(KEY, isText, 1_000 + EDITOR_DRAFT_MAX_AGE_MS + 1)).toBeNull();
		expect(driver.data.has(KEY)).toBe(false);
	});

	it('deletes only a copy it names, also when a newer one has the same timestamp', async () => {
		const driver = memoryDriver();
		const store = createEditorDraftStore(driver);
		const older = copy({ token: 'tab-a.1#1', seq: 1, data: { text: 'old' } });
		const newer = copy({ token: 'tab-a.1#2', seq: 2, data: { text: 'new unsaved text' } });
		await store.write(KEY, older);
		await store.write(KEY, newer);
		expect(await store.removeIf(KEY, [older.token])).toBe(false);
		expect((await store.read(KEY, isText, 1_001))?.data).toEqual({ text: 'new unsaved text' });
		expect(await store.removeIf(KEY, [older.token, newer.token])).toBe(true);
		expect(driver.data.has(KEY)).toBe(false);
	});

	it('lands operations on one key in the order they were asked for', async () => {
		const driver = memoryDriver();
		const gate = deferred();
		const set = driver.set;
		let held = true;
		driver.set = async (key, value) => {
			// The first write is slow (IndexedDB busy); the rest are quick.
			if (held) {
				held = false;
				await gate.promise;
			}
			await set(key, value);
		};
		const store = createEditorDraftStore(driver);
		const a = copy({ token: 'tab-a.1#1', seq: 1, data: { text: 'A' } });
		const b = copy({ token: 'tab-a.1#2', seq: 2, data: { text: 'B' } });
		const writeA = store.write(KEY, a);
		const writeB = store.write(KEY, b);
		const cleanupA = store.removeIf(KEY, [a.token]);
		gate.resolve();
		expect(await writeA).toBe(true);
		expect(await writeB).toBe(true);
		expect(await cleanupA).toBe(false);
		expect((driver.data.get(KEY) as { data: unknown }).data).toEqual({ text: 'B' });
	});

	it('says so when nothing can be stored', async () => {
		const store = createEditorDraftStore(memoryDriver(false));
		expect(store.persistent).toBe(false);
		expect(await store.write(KEY, copy())).toBe(false);
	});

	it('prunes expired and malformed copies under its own prefix only', async () => {
		const driver = memoryDriver();
		const store = createEditorDraftStore(driver);
		const fresh = editorDraftKey(
			editorDraftScope({ userId: 'u', organizationId: 'o', kind: 'campaign', id: 'a' }),
			'tab-a.1'
		);
		driver.data.set(KEY, copy({ savedAt: 0 }));
		driver.data.set(fresh, copy({ savedAt: EDITOR_DRAFT_MAX_AGE_MS }));
		driver.data.set('composer-draft:v1:other', { anything: true });
		await store.prune(EDITOR_DRAFT_MAX_AGE_MS + 10);
		expect([...driver.data.keys()].sort()).toEqual(['composer-draft:v1:other', fresh].sort());
	});
});

describe('editorDraftStore on IndexedDB', () => {
	const original = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
	afterEach(() => {
		if (original) Object.defineProperty(globalThis, 'indexedDB', original);
		else delete (globalThis as { indexedDB?: unknown }).indexedDB;
	});

	it('compares the token inside the delete transaction', async () => {
		Object.defineProperty(globalThis, 'indexedDB', {
			configurable: true,
			writable: true,
			value: new IDBFactory(),
		});
		const driver = createIndexedDbDriver('editor-drafts-test', 'kv');
		if (!driver) throw new Error('fake-indexeddb was not installed');
		const store = createEditorDraftStore(driver);
		const older = copy({ token: 'tab-a.1#1', data: { text: 'old' } });
		const newer = copy({ token: 'tab-a.1#2', seq: 2, data: { text: 'new unsaved text' } });
		expect(await store.write(KEY, older)).toBe(true);
		expect(await store.write(KEY, newer)).toBe(true);
		expect(await store.removeIf(KEY, [older.token])).toBe(false);
		expect((await store.read(KEY, isText, 1_001))?.data).toEqual({ text: 'new unsaved text' });
		expect(await store.removeIf(KEY, [newer.token])).toBe(true);
		expect(await store.read(KEY, isText, 1_001)).toBeNull();
	});
});
