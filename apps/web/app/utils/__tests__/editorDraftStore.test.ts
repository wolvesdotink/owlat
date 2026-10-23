/**
 * The device copy of editor drafts (`editorDraftStore.ts`): only well-formed,
 * young copies are handed back, and a delete never takes a newer copy with it.
 */
import { describe, expect, it } from 'vitest';
import { reactive } from 'vue';
import type { OfflineKvDriver } from '../postboxOfflineKvDriver';
import {
	EDITOR_DRAFT_MAX_AGE_MS,
	createEditorDraftStore,
	editorDraftKey,
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

const KEY = editorDraftKey({
	userId: 'user_1',
	organizationId: 'org_1',
	kind: 'campaign',
	id: 'cmp_1',
});
const isText = (data: unknown): data is { text: string } =>
	typeof (data as { text?: unknown } | null)?.text === 'string';
const copy = (over: Partial<EditorDraftCopy<{ text: string }>> = {}) => ({
	v: 1 as const,
	savedAt: 1_000,
	base: 7,
	data: { text: 'kept' },
	...over,
});

describe('editorDraftStore', () => {
	it('namespaces keys by person, workspace, kind and draft', () => {
		expect(KEY).toBe('editor-draft:v1:user_1:org_1:campaign:cmp_1');
	});

	it('stores reactive state and reads it back', async () => {
		const store = createEditorDraftStore(memoryDriver());
		const data = reactive({ text: 'kept' });
		expect(await store.write(KEY, copy({ data }))).toBe(true);
		expect(await store.read(KEY, isText, 2_000)).toEqual(copy());
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

	it('deletes only the copy it was asked about', async () => {
		const driver = memoryDriver();
		const store = createEditorDraftStore(driver);
		await store.write(KEY, copy({ savedAt: 2_000 }));
		await store.removeIf(KEY, 1_000);
		expect(driver.data.has(KEY)).toBe(true);
		await store.removeIf(KEY, 2_000);
		expect(driver.data.has(KEY)).toBe(false);
	});

	it('says so when nothing can be stored', async () => {
		const store = createEditorDraftStore(memoryDriver(false));
		expect(store.persistent).toBe(false);
		expect(await store.write(KEY, copy())).toBe(false);
	});

	it('prunes expired and malformed copies under its own prefix only', async () => {
		const driver = memoryDriver();
		const store = createEditorDraftStore(driver);
		const fresh = editorDraftKey({ userId: 'u', organizationId: 'o', kind: 'campaign', id: 'a' });
		driver.data.set(KEY, copy({ savedAt: 0 }));
		driver.data.set(fresh, copy({ savedAt: EDITOR_DRAFT_MAX_AGE_MS }));
		driver.data.set('composer-draft:v1:other', { anything: true });
		await store.prune(EDITOR_DRAFT_MAX_AGE_MS + 10);
		expect([...driver.data.keys()].sort()).toEqual(['composer-draft:v1:other', fresh].sort());
	});
});
