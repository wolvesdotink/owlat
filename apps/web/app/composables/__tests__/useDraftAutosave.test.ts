/**
 * The draft autosave engine (`useDraftAutosave.ts`): when it saves, what it
 * keeps on the device, and what it reports. Fake timers only; nothing waits
 * on the real clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';
import type { OfflineKvDriver } from '~/utils/postboxOfflineKvDriver';
import { createEditorDraftStore } from '~/utils/editorDraftStore';
import { useDraftAutosave, type DraftAutosaveOptions } from '../useDraftAutosave';

function memoryDriver(persistent = true): OfflineKvDriver & { data: Map<string, unknown> } {
	const data = new Map<string, unknown>();
	const clone = <T>(value: T): T => structuredClone(value);
	return {
		data,
		persistent,
		get: async <T>(key: string) => (data.has(key) ? clone(data.get(key)) : undefined) as T,
		set: async (key, value) => {
			data.set(key, clone(value));
		},
		delete: async (key) => {
			data.delete(key);
		},
		keys: async () => [...data.keys()],
		clear: async () => data.clear(),
		deleteIf: async (key, predicate) => {
			if (!predicate(clone(data.get(key)))) return false;
			data.delete(key);
			return true;
		},
	};
}

/** A deferred save the test settles by hand. */
function deferred() {
	let resolve!: () => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const KEY = 'editor-draft:v1:user_1:org_1:emailTemplate:tpl_1';

/** An editor with one text field, a dirty flag and a revision. */
function setup(over: Partial<DraftAutosaveOptions<{ text: string }>> = {}) {
	const text = ref('saved');
	const serverText = ref('saved');
	const dirty = ref(false);
	const enabled = ref(true);
	const paused = ref(false);
	const online = ref(true);
	const driver = memoryDriver();
	const saves: string[] = [];
	let pending: ReturnType<typeof deferred> | null = null;
	const save = vi.fn(async () => {
		const sent = text.value;
		saves.push(sent);
		if (pending) await pending.promise;
		serverText.value = sent;
		if (text.value === sent) dirty.value = false;
	});
	const scope = effectScope();
	const autosave = scope.run(() =>
		useDraftAutosave<{ text: string }>({
			enabled: () => enabled.value,
			paused: () => paused.value,
			dirty: () => dirty.value,
			changes: [text],
			save,
			online: () => online.value,
			store: createEditorDraftStore(driver),
			mirror: { key: () => KEY, snapshot: () => ({ text: text.value }), base: () => 3 },
			...over,
		})
	)!;
	const edit = async (value: string) => {
		text.value = value;
		dirty.value = true;
		await nextTick();
	};
	return {
		autosave,
		text,
		serverText,
		dirty,
		enabled,
		paused,
		online,
		driver,
		saves,
		save,
		scope,
		edit,
		hold: () => {
			pending = deferred();
			return pending;
		},
		release: () => {
			pending = null;
		},
	};
}

/** Let the store's promise chains settle (no timers involved). */
const settle = async () => {
	for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('useDraftAutosave', () => {
	it('saves nothing for a draft nobody edited', async () => {
		const t = setup();
		await vi.advanceTimersByTimeAsync(5000);
		expect(t.save).not.toHaveBeenCalled();
		expect(t.driver.data.size).toBe(0);
		expect(t.autosave.status.value).toBe('idle');
	});

	it('saves the latest draft once the edits pause', async () => {
		const t = setup();
		await t.edit('a');
		await vi.advanceTimersByTimeAsync(1000);
		await t.edit('ab');
		await vi.advanceTimersByTimeAsync(1000);
		expect(t.save).not.toHaveBeenCalled();
		expect(t.autosave.status.value).toBe('saving');

		await vi.advanceTimersByTimeAsync(600);
		expect(t.saves).toEqual(['ab']);
		expect(t.autosave.status.value).toBe('saved');
		expect(t.autosave.savedAt.value).not.toBeNull();
	});

	it('saves an edit made while a save is in flight after it', async () => {
		const t = setup();
		const flight = t.hold();
		await t.edit('one');
		await vi.advanceTimersByTimeAsync(1500);
		expect(t.saves).toEqual(['one']);

		await t.edit('two');
		t.release();
		flight.resolve();
		await vi.advanceTimersByTimeAsync(0);
		expect(t.dirty.value).toBe(true);

		await vi.advanceTimersByTimeAsync(1500);
		expect(t.saves).toEqual(['one', 'two']);
		expect(t.serverText.value).toBe('two');
		expect(t.dirty.value).toBe(false);
	});

	it('keeps the draft on the device until a save of it lands', async () => {
		const t = setup();
		const flight = t.hold();
		await t.edit('typed');
		await vi.advanceTimersByTimeAsync(300);
		await settle();
		expect(t.driver.data.get(KEY)).toMatchObject({ v: 1, base: 3, data: { text: 'typed' } });
		expect(t.autosave.onDevice.value).toBe(true);
		expect(t.autosave.atRisk.value).toBe(false);

		await vi.advanceTimersByTimeAsync(1200);
		flight.resolve();
		await vi.advanceTimersByTimeAsync(0);
		await settle();
		expect(t.driver.data.has(KEY)).toBe(false);
	});

	it('keeps the copy after a failed save, shows the failure and retries', async () => {
		const t = setup();
		t.save.mockRejectedValueOnce(new Error('refused'));
		await t.edit('typed');
		await vi.advanceTimersByTimeAsync(1500);
		await settle();
		expect(t.autosave.status.value).toBe('error');
		expect(t.autosave.error.value).toBeInstanceOf(Error);
		expect(t.dirty.value).toBe(true);
		expect(t.driver.data.has(KEY)).toBe(true);

		t.autosave.retry();
		await vi.advanceTimersByTimeAsync(0);
		await settle();
		expect(t.save).toHaveBeenCalledTimes(2);
		expect(t.serverText.value).toBe('typed');
		expect(t.autosave.status.value).toBe('saved');
		expect(t.driver.data.has(KEY)).toBe(false);
	});

	it('reports offline with the copy on the device, and saves when the backend is back', async () => {
		const t = setup();
		t.online.value = false;
		const flight = t.hold();
		await t.edit('offline edit');
		await vi.advanceTimersByTimeAsync(1500);
		await settle();
		expect(t.autosave.status.value).toBe('offline');
		expect(t.autosave.onDevice.value).toBe(true);
		expect(t.autosave.atRisk.value).toBe(false);

		t.online.value = true;
		flight.resolve();
		await vi.advanceTimersByTimeAsync(0);
		await settle();
		expect(t.autosave.status.value).toBe('saved');
	});

	it('counts an edit as at risk while no device copy could be written', async () => {
		const t = setup({ store: createEditorDraftStore(memoryDriver(false)) });
		t.hold();
		await t.edit('typed');
		await vi.advanceTimersByTimeAsync(1500);
		expect(t.autosave.onDevice.value).toBe(false);
		expect(t.autosave.atRisk.value).toBe(true);
	});

	it('waits while paused and saves once it may', async () => {
		const t = setup();
		t.paused.value = true;
		await t.edit('typed');
		await vi.advanceTimersByTimeAsync(5000);
		expect(t.save).not.toHaveBeenCalled();

		t.paused.value = false;
		await nextTick();
		await vi.advanceTimersByTimeAsync(1500);
		expect(t.saves).toEqual(['typed']);
	});

	it('flushes at once and reports whether everything landed', async () => {
		const t = setup();
		await t.edit('now');
		expect(await t.autosave.flush()).toBe(true);
		expect(t.saves).toEqual(['now']);

		t.save.mockRejectedValueOnce(new Error('refused'));
		await t.edit('later');
		expect(await t.autosave.flush()).toBe(false);
		expect(t.autosave.status.value).toBe('error');
	});

	it('commits typing the draft cannot see before a flush saves', async () => {
		const open = ref(true);
		const t = setup({
			uncommitted: () => open.value,
			commit: () => {
				open.value = false;
				t.text.value = 'from the text editor';
				t.dirty.value = true;
			},
		});
		expect(t.autosave.status.value).toBe('editing');
		expect(await t.autosave.flush()).toBe(true);
		expect(t.saves).toEqual(['from the text editor']);
	});

	it('saves what is pending when the editor goes away', async () => {
		const t = setup();
		await t.edit('leaving');
		t.scope.stop();
		await settle();
		expect(t.saves).toEqual(['leaving']);
	});

	it('rewrites the copy on the new base when it holds what the server does not', async () => {
		let base = 3;
		const t = setup({
			mirror: {
				key: () => KEY,
				snapshot: () => ({ text: 'device-only choice' }),
				base: () => base,
				keepAfterSave: () => true,
			},
		});
		await t.edit('x');
		base = 4;
		await vi.advanceTimersByTimeAsync(1500);
		await settle();
		expect(t.driver.data.get(KEY)).toMatchObject({ base: 4 });
	});

	it('drops the pending save and the copy when the draft is discarded', async () => {
		const t = setup();
		await t.edit('typed');
		await vi.advanceTimersByTimeAsync(300);
		await settle();
		t.autosave.cancel();
		await settle();
		await vi.advanceTimersByTimeAsync(5000);
		expect(t.save).not.toHaveBeenCalled();
		expect(t.driver.data.has(KEY)).toBe(false);
	});
});
