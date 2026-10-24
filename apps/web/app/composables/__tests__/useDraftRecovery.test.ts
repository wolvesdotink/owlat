/**
 * Recovery of device copies when an editor opens (`useDraftRecovery.ts`): a
 * stale copy is deleted, a copy built on the state the server still holds is
 * applied, any other copy waits for the person's choice, and a copy whose
 * editor is still open is left to it.
 */
import { describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';
import {
	createEditorDraftStore,
	editorDraftKey,
	type EditorDraftCopy,
} from '~/utils/editorDraftStore';
import { createEditorDraftWriters } from '~/utils/editorDraftWriters';
import { createNoopDriver, type OfflineKvDriver } from '~/utils/postboxOfflineKvDriver';
import { useDraftRecovery } from '../useDraftRecovery';

function memoryDriver(): OfflineKvDriver & { data: Map<string, unknown> } {
	const data = new Map<string, unknown>();
	return {
		...createNoopDriver(),
		persistent: true,
		data,
		get: async <T>(key: string) => data.get(key) as T,
		set: async (key, value) => {
			data.set(key, value);
		},
		delete: async (key) => {
			data.delete(key);
		},
		keys: async () => [...data.keys()],
		deleteIf: async (key, predicate) => {
			if (!predicate(data.get(key))) return false;
			data.delete(key);
			return true;
		},
	};
}

const SCOPE = 'editor-draft:v1:u:o:emailTemplate:t:';
/** A copy left behind by an editor of a tab that has closed. */
const KEY = editorDraftKey(SCOPE, 'tab-old.1');
const isText = (data: unknown): data is { text: string } =>
	typeof (data as { text?: unknown } | null)?.text === 'string';
const settle = async () => {
	for (let i = 0; i < 50; i++) await Promise.resolve();
};

async function setup(
	stored: EditorDraftCopy<{ text: string }> | null,
	serverRevision = 7,
	over: { keep?: () => Promise<boolean>; driver?: ReturnType<typeof memoryDriver> } = {}
) {
	const driver = over.driver ?? memoryDriver();
	if (stored) driver.data.set(KEY, stored);
	const text = ref('server text');
	const ready = ref(false);
	const applied = vi.fn();
	const writers = createEditorDraftWriters('tab-a', null);
	const recovery = effectScope().run(() =>
		useDraftRecovery<{ text: string }>({
			scope: () => SCOPE,
			ready: () => ready.value,
			accept: isText,
			matches: (data) => data.text === text.value,
			canApply: (copy) => copy.base === serverRevision,
			apply: (data) => {
				text.value = data.text;
			},
			onApplied: applied,
			keep: over.keep,
			store: createEditorDraftStore(driver),
			writers,
		})
	)!;
	ready.value = true;
	await nextTick();
	await settle();
	return { driver, text, recovery, applied };
}

const copy = (text: string, base: number) => ({
	v: 1 as const,
	savedAt: Date.now(),
	base,
	data: { text },
});

describe('useDraftRecovery', () => {
	it('waits until the editor has loaded the server state', async () => {
		const driver = memoryDriver();
		driver.data.set(KEY, copy('device text', 7));
		const read = vi.spyOn(driver, 'get');
		effectScope().run(() =>
			useDraftRecovery<{ text: string }>({
				scope: () => SCOPE,
				ready: () => false,
				accept: isText,
				matches: () => false,
				canApply: () => true,
				apply: vi.fn(),
				store: createEditorDraftStore(driver),
			})
		);
		await settle();
		expect(read).not.toHaveBeenCalled();
	});

	it('deletes a copy that says what the editor already shows', async () => {
		const { driver, recovery, text } = await setup(copy('server text', 7));
		expect(driver.data.has(KEY)).toBe(false);
		expect(recovery.pending.value).toBeNull();
		expect(text.value).toBe('server text');
	});

	it('applies a copy built on the state the server still holds', async () => {
		const { text, recovery, applied } = await setup(copy('typed offline', 7));
		expect(text.value).toBe('typed offline');
		expect(applied).toHaveBeenCalledOnce();
		expect(recovery.pending.value).toBeNull();
	});

	it('offers a copy the server moved past instead of applying it', async () => {
		const { text, recovery, driver } = await setup(copy('typed offline', 6));
		expect(text.value).toBe('server text');
		expect(recovery.pending.value?.data.text).toBe('typed offline');

		recovery.restore();
		expect(text.value).toBe('typed offline');
		expect(recovery.pending.value).toBeNull();
		// The restored text is this editor's now, kept under its own key.
		await settle();
		expect(driver.data.has(KEY)).toBe(false);
	});

	it('deletes the applied copy only once the editor kept its own', async () => {
		const kept = await setup(copy('typed offline', 7), 7, { keep: async () => true });
		expect(kept.text.value).toBe('typed offline');
		expect(kept.driver.data.has(KEY)).toBe(false);

		const notKept = await setup(copy('typed offline', 7), 7, { keep: async () => false });
		expect(notKept.text.value).toBe('typed offline');
		expect(notKept.driver.data.has(KEY)).toBe(true);
	});

	it('leaves a copy whose editor is still open to it', async () => {
		const driver = memoryDriver();
		const writers = createEditorDraftWriters('tab-a', null);
		const openEditor = writers.open();
		const openKey = editorDraftKey(SCOPE, openEditor.id);
		driver.data.set(openKey, copy('typed in the open editor', 7));
		const text = ref('server text');
		const recovery = effectScope().run(() =>
			useDraftRecovery<{ text: string }>({
				scope: () => SCOPE,
				ready: () => true,
				accept: isText,
				matches: (data) => data.text === text.value,
				canApply: () => true,
				apply: (data) => {
					text.value = data.text;
				},
				store: createEditorDraftStore(driver),
				writers,
			})
		)!;
		await settle();
		expect(text.value).toBe('server text');
		expect(recovery.pending.value).toBeNull();
		expect(driver.data.has(openKey)).toBe(true);
	});

	it('offers the newest left-behind copy and drops the stale ones', async () => {
		const driver = memoryDriver();
		const stale = editorDraftKey(SCOPE, 'tab-old.2');
		const older = editorDraftKey(SCOPE, 'tab-old.3');
		driver.data.set(stale, { ...copy('server text', 6), savedAt: Date.now() - 1_000 });
		driver.data.set(older, { ...copy('older offline edit', 6), savedAt: Date.now() - 3_000 });
		const { recovery } = await setup(
			{ ...copy('newer offline edit', 6), savedAt: Date.now() - 2_000 },
			7,
			{
				driver,
			}
		);
		expect(recovery.pending.value?.data.text).toBe('newer offline edit');
		expect(driver.data.has(stale)).toBe(false);
		expect(driver.data.has(older)).toBe(true);
	});

	it('offers a copy instead of applying it when the editor was edited during the read', async () => {
		const driver = memoryDriver();
		driver.data.set(KEY, copy('typed offline', 7));
		let finishRead!: () => void;
		const keys = driver.keys;
		driver.keys = async () => {
			await new Promise<void>((resolve) => {
				finishRead = resolve;
			});
			return await keys();
		};
		const text = ref('server text');
		const edits = ref(0);
		const recovery = effectScope().run(() =>
			useDraftRecovery<{ text: string }>({
				scope: () => SCOPE,
				ready: () => true,
				edits: () => edits.value,
				accept: isText,
				matches: (data) => data.text === text.value,
				canApply: () => true,
				apply: (data) => {
					text.value = data.text;
				},
				store: createEditorDraftStore(driver),
				writers: createEditorDraftWriters('tab-a', null),
			})
		)!;
		await settle();
		// Typed into the editor while the device copies were still being read.
		text.value = 'typed just now';
		edits.value += 1;
		finishRead();
		await settle();

		expect(text.value).toBe('typed just now');
		expect(recovery.pending.value?.data.text).toBe('typed offline');
	});

	it('discards an offered copy on request', async () => {
		const { text, recovery, driver } = await setup(copy('typed offline', 6));
		recovery.discard();
		await settle();
		expect(text.value).toBe('server text');
		expect(driver.data.has(KEY)).toBe(false);
	});

	it('does nothing without a copy', async () => {
		const { recovery, applied } = await setup(null);
		expect(recovery.pending.value).toBeNull();
		expect(applied).not.toHaveBeenCalled();
	});
});
