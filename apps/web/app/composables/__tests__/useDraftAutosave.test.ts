/**
 * The draft autosave engine (`useDraftAutosave.ts`): when it saves, what it
 * keeps on the device, and what it reports. Fake timers only; nothing waits
 * on the real clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';
import type { OfflineKvDriver } from '~/utils/postboxOfflineKvDriver';
import { createEditorDraftStore, editorDraftKey } from '~/utils/editorDraftStore';
import { createEditorDraftWriters } from '~/utils/editorDraftWriters';
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

const SCOPE = 'editor-draft:v1:user_1:org_1:emailTemplate:tpl_1:';
/** The copy of the first editor opened in tab A. */
const KEY = editorDraftKey(SCOPE, 'tab-a.1');

/**
 * An editor with one text field, a dirty flag and a revision; `env` puts
 * several of them on one device (shared storage, a tab each).
 */
function setup(
	over: Partial<DraftAutosaveOptions<{ text: string }>> = {},
	env: { driver?: ReturnType<typeof memoryDriver>; tab?: string } = {}
) {
	const text = ref('saved');
	const serverText = ref('saved');
	const dirty = ref(false);
	const enabled = ref(true);
	const paused = ref(false);
	const online = ref(true);
	const driver = env.driver ?? memoryDriver();
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
			writers: createEditorDraftWriters(env.tab ?? 'tab-a', null),
			mirror: { scope: () => SCOPE, snapshot: () => ({ text: text.value }), base: () => 3 },
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

	describe('commitBeforeLeaving', () => {
		/** An editor with text open that commits to `typed`. */
		const typing = (over: Partial<DraftAutosaveOptions<{ text: string }>> = {}) => {
			const open = ref(true);
			const t = setup({
				uncommitted: () => open.value,
				commit: () => {
					open.value = false;
					t.text.value = 'typed';
					t.dirty.value = true;
				},
				...over,
			});
			return t;
		};

		it('commits the open text and writes its copy, so nothing is at risk', async () => {
			const t = typing();
			expect(t.autosave.atRisk.value).toBe(false);
			await t.autosave.commitBeforeLeaving();
			expect(t.text.value).toBe('typed');
			expect(t.driver.data.get(KEY)).toMatchObject({ data: { text: 'typed' } });
			expect(t.autosave.onDevice.value).toBe(true);
			expect(t.autosave.atRisk.value).toBe(false);
		});

		it('leaves the committed text at risk when the device cannot keep it', async () => {
			const t = typing({ store: createEditorDraftStore(memoryDriver(false)) });
			await t.autosave.commitBeforeLeaving();
			expect(t.text.value).toBe('typed');
			expect(t.autosave.atRisk.value).toBe(true);
		});

		it('stops waiting for a write that hangs, with the text still at risk', async () => {
			const driver = memoryDriver();
			driver.set = () => new Promise<void>(() => {});
			const t = typing({ store: createEditorDraftStore(driver) });
			let done = false;
			void t.autosave.commitBeforeLeaving().then(() => {
				done = true;
			});
			await settle();
			expect(done).toBe(false);
			await vi.advanceTimersByTimeAsync(1000);
			expect(done).toBe(true);
			expect(t.autosave.atRisk.value).toBe(true);
		});

		it('does nothing while no text is open', async () => {
			const t = typing({ uncommitted: () => false });
			// Nothing to wait for: the leave guard decides at once.
			expect(t.autosave.commitBeforeLeaving()).toBeUndefined();
			expect(t.text.value).toBe('saved');
			expect(t.driver.data.size).toBe(0);
		});
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
				scope: () => SCOPE,
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
		expect(t.autosave.status.value).toBe('saved');
		expect(t.autosave.atRisk.value).toBe(false);
	});

	it('keeps a choice only the device holds at risk while its copy cannot be written', async () => {
		const t = setup({
			store: createEditorDraftStore(memoryDriver(false)),
			mirror: {
				scope: () => SCOPE,
				snapshot: () => ({ text: 'device-only choice' }),
				base: () => 3,
				keepAfterSave: () => true,
			},
		});
		await t.edit('x');
		await vi.advanceTimersByTimeAsync(1500);
		await settle();
		// The save landed, but what only the device holds is nowhere.
		expect(t.saves).toEqual(['x']);
		expect(t.dirty.value).toBe(false);
		expect(t.autosave.status.value).toBe('unkept');
		expect(t.autosave.atRisk.value).toBe(true);

		t.autosave.cancel();
		expect(t.autosave.atRisk.value).toBe(false);
	});

	it('keeps a choice only the device holds at risk until its copy is written', async () => {
		const driver = memoryDriver();
		const waiting: Array<() => void> = [];
		const set = driver.set;
		// Every write waits until the test lets it commit.
		driver.set = async (key, value) => {
			await new Promise<void>((resolve) => waiting.push(resolve));
			await set(key, value);
		};
		const t = setup({
			store: createEditorDraftStore(driver),
			mirror: {
				scope: () => SCOPE,
				snapshot: () => ({ text: 'device-only choice' }),
				base: () => 3,
				keepAfterSave: () => true,
			},
		});
		await t.edit('x');
		await vi.advanceTimersByTimeAsync(1500);
		await settle();
		// The save landed; the copy holding the choice has not committed yet.
		expect(t.saves).toEqual(['x']);
		expect(t.dirty.value).toBe(false);
		expect(t.autosave.onDevice.value).toBe(false);
		expect(t.autosave.atRisk.value).toBe(true);

		// The writes (the delayed copy, the rewrite after the save) commit.
		expect(waiting).toHaveLength(2);
		for (const commit of waiting.splice(0)) commit();
		await settle();
		expect(t.autosave.onDevice.value).toBe(true);
		expect(t.autosave.atRisk.value).toBe(false);
	});

	it('waits while a save-or-discard choice is open, and saves for its Save', async () => {
		const choosing = ref(false);
		const t = setup({ held: () => choosing.value });
		await t.edit('typed');
		choosing.value = true;
		await vi.advanceTimersByTimeAsync(5000);
		expect(t.save).not.toHaveBeenCalled();

		expect(await t.autosave.flush()).toBe(true);
		expect(t.saves).toEqual(['typed']);
	});

	it('saves nothing while the choice is open, and nothing after its Discard', async () => {
		const choosing = ref(false);
		const t = setup({ held: () => choosing.value });
		await t.edit('typed');
		choosing.value = true;
		await vi.advanceTimersByTimeAsync(5000);
		t.autosave.cancel();
		choosing.value = false;
		await nextTick();
		await vi.advanceTimersByTimeAsync(5000);
		expect(t.save).not.toHaveBeenCalled();
	});

	it('saves once a choice closes without a decision', async () => {
		const choosing = ref(false);
		const t = setup({ held: () => choosing.value });
		choosing.value = true;
		await t.edit('typed');
		await vi.advanceTimersByTimeAsync(5000);
		choosing.value = false;
		await nextTick();
		await vi.advanceTimersByTimeAsync(1500);
		expect(t.saves).toEqual(['typed']);
	});

	it("keeps each tab's copy apart, so neither loses its edits to the other", async () => {
		const driver = memoryDriver();
		const a = setup({}, { driver, tab: 'tab-a' });
		const b = setup({}, { driver, tab: 'tab-b' });
		for (const tab of [a, b]) {
			tab.online.value = false;
			tab.hold();
		}
		await a.edit('from A');
		await b.edit('from B');
		await vi.advanceTimersByTimeAsync(300);
		await settle();

		expect(driver.data.get(editorDraftKey(SCOPE, 'tab-a.1'))).toMatchObject({
			data: { text: 'from A' },
		});
		expect(driver.data.get(editorDraftKey(SCOPE, 'tab-b.1'))).toMatchObject({
			data: { text: 'from B' },
		});
		expect(a.autosave.onDevice.value).toBe(true);
		expect(b.autosave.onDevice.value).toBe(true);
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

	it('saves nothing it discarded when the editor goes away right after', async () => {
		const t = setup();
		await t.edit('discarded');
		t.autosave.cancel();
		t.scope.stop();
		await settle();
		await vi.advanceTimersByTimeAsync(5000);
		expect(t.save).not.toHaveBeenCalled();
		expect(t.driver.data.size).toBe(0);
	});

	it('saves again after an edit that follows a discard', async () => {
		const t = setup();
		await t.edit('discarded');
		t.autosave.cancel();
		await t.edit('kept');
		await vi.advanceTimersByTimeAsync(1500);
		expect(t.saves).toEqual(['kept']);
	});
});
