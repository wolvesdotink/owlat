/**
 * Recovery of a device copy when an editor opens (`useDraftRecovery.ts`): a
 * stale copy is deleted, a copy built on the state the server still holds is
 * applied, and any other copy waits for the person's choice.
 */
import { describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';
import { createEditorDraftStore, type EditorDraftCopy } from '~/utils/editorDraftStore';
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
		deleteIf: async (key, predicate) => {
			if (!predicate(data.get(key))) return false;
			data.delete(key);
			return true;
		},
	};
}

const KEY = 'editor-draft:v1:u:o:emailTemplate:t';
const isText = (data: unknown): data is { text: string } =>
	typeof (data as { text?: unknown } | null)?.text === 'string';
const settle = async () => {
	for (let i = 0; i < 10; i++) await Promise.resolve();
};

async function setup(stored: EditorDraftCopy<{ text: string }> | null, serverRevision = 7) {
	const driver = memoryDriver();
	if (stored) driver.data.set(KEY, stored);
	const text = ref('server text');
	const ready = ref(false);
	const applied = vi.fn();
	const recovery = effectScope().run(() =>
		useDraftRecovery<{ text: string }>({
			key: () => KEY,
			ready: () => ready.value,
			accept: isText,
			matches: (data) => data.text === text.value,
			canApply: (copy) => copy.base === serverRevision,
			apply: (data) => {
				text.value = data.text;
			},
			onApplied: applied,
			store: createEditorDraftStore(driver),
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
				key: () => KEY,
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
		// The editor's autosave replaces the copy once it saves the restored text.
		expect(driver.data.has(KEY)).toBe(true);
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
