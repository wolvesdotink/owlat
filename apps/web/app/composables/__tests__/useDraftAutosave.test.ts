/**
 * The draft autosave runner (`useDraftAutosave.ts`): it runs what the
 * session (`utils/draftSession.ts`) decides against real timers, storage and
 * a save, and reports the outcomes back. Fake timers only; nothing waits on
 * the real clock. The editor is one text field.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref, watch } from 'vue';
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

/** A promise the test settles by hand. */
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
const fp = (value: unknown) => JSON.stringify(value);
type Draft = { text: string };
const isDraft = (data: unknown): data is Draft =>
	typeof (data as { text?: unknown } | null)?.text === 'string';

/**
 * An editor with one text field on revision 3; `env` puts several on one
 * device (shared storage, a tab each). The test plays the editor's binding:
 * it loads the draft and reports each edit.
 */
function setup(
	over: Partial<DraftAutosaveOptions<Draft>> = {},
	env: { driver?: ReturnType<typeof memoryDriver>; tab?: string; locks?: boolean } = {}
) {
	const text = ref('saved');
	const serverText = ref('saved');
	const enabled = ref(true);
	const online = ref(true);
	const open = ref(false);
	const driver = env.driver ?? memoryDriver();
	const saves: string[] = [];
	let pending: ReturnType<typeof deferred> | null = null;
	let revision = 3;
	const persist = vi.fn(async () => {
		const sent = text.value;
		saves.push(sent);
		if (pending) await pending.promise;
		serverText.value = sent;
		revision += 1;
		return { revision };
	});
	const scope = effectScope();
	const autosave = scope.run(() => {
		const draft = useDraftAutosave<Draft>({
			enabled: () => enabled.value,
			scope: () => SCOPE,
			read: () => ({ values: { text: fp(text.value) } }),
			snapshot: () => ({ text: text.value }),
			persist,
			inline: () => open.value,
			commitInline: () => {
				open.value = false;
				text.value = 'from the text editor';
			},
			accept: isDraft,
			matches: (data) => data.text === text.value,
			apply: (data) => {
				text.value = data.text;
			},
			online: () => online.value,
			store: createEditorDraftStore(driver),
			// A browser with Web Locks: another tab's editor is open only while it holds its lock.
			writers: createEditorDraftWriters(
				env.tab ?? 'tab-a',
				env.locks === false ? null : noLocksHeld
			),
			...over,
		});
		watch(text, (value) => draft.edit({ text: fp(value) }));
		draft.dispatch({ type: 'hydrated', revision: 3, values: { text: fp('saved') }, fresh: false });
		return draft;
	})!;
	const edit = async (value: string) => {
		text.value = value;
		await nextTick();
	};
	return {
		autosave,
		text,
		serverText,
		enabled,
		online,
		open,
		driver,
		saves,
		persist,
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

/** Web Locks where no other editor holds one. */
const noLocksHeld = {
	request: async () => undefined,
	query: async () => ({ held: [], pending: [] }),
} as unknown as Pick<LockManager, 'request' | 'query'>;

/** Let promise chains settle (no timers involved). */
const settle = async () => {
	for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('useDraftAutosave: saving', () => {
	it('saves nothing for a draft nobody edited', async () => {
		const t = setup();
		await vi.advanceTimersByTimeAsync(5000);
		expect(t.persist).not.toHaveBeenCalled();
		expect(t.driver.data.size).toBe(0);
		expect(t.autosave.status.value).toBe('idle');
	});

	it('saves the latest draft once the edits pause', async () => {
		const t = setup();
		await t.edit('a');
		await vi.advanceTimersByTimeAsync(1000);
		await t.edit('ab');
		await vi.advanceTimersByTimeAsync(1000);
		expect(t.persist).not.toHaveBeenCalled();
		expect(t.autosave.status.value).toBe('saving');

		await vi.advanceTimersByTimeAsync(600);
		expect(t.saves).toEqual(['ab']);
		expect(t.persist.mock.calls[0]?.[0]).toMatchObject({ baseRevision: 3 });
		expect(t.autosave.status.value).toBe('saved');
		expect(t.autosave.savedAt.value).not.toBeNull();
	});

	it('saves an edit made while a save is in flight after it, on the revision it stored', async () => {
		const t = setup();
		const flight = t.hold();
		await t.edit('one');
		await vi.advanceTimersByTimeAsync(1500);
		expect(t.saves).toEqual(['one']);

		await t.edit('two');
		t.release();
		flight.resolve();
		await vi.advanceTimersByTimeAsync(0);
		expect(t.autosave.dirty.value).toBe(true);

		await vi.advanceTimersByTimeAsync(1500);
		expect(t.saves).toEqual(['one', 'two']);
		expect(t.persist.mock.calls[1]?.[0]).toMatchObject({ baseRevision: 4 });
		expect(t.autosave.dirty.value).toBe(false);
	});

	it('keeps the draft on the device until a save of it lands', async () => {
		const t = setup();
		const flight = t.hold();
		await t.edit('typed');
		await vi.advanceTimersByTimeAsync(300);
		await settle();
		expect(t.driver.data.get(KEY)).toMatchObject({
			v: 2,
			token: 'tab-a.1#1',
			seq: 1,
			base: 3,
			data: { text: 'typed' },
		});
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
		t.persist.mockRejectedValueOnce(new Error('refused'));
		await t.edit('typed');
		await vi.advanceTimersByTimeAsync(1500);
		await settle();
		expect(t.autosave.status.value).toBe('error');
		expect(t.autosave.error.value).toBeInstanceOf(Error);
		expect(t.autosave.dirty.value).toBe(true);
		expect(t.driver.data.has(KEY)).toBe(true);

		t.autosave.retry();
		await vi.advanceTimersByTimeAsync(0);
		await settle();
		expect(t.persist).toHaveBeenCalledTimes(2);
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

	it('does nothing while autosave does not apply', async () => {
		const t = setup();
		t.enabled.value = false;
		await t.edit('published');
		await vi.advanceTimersByTimeAsync(5000);
		expect(t.persist).not.toHaveBeenCalled();
		expect(t.driver.data.size).toBe(0);
		expect(t.autosave.status.value).toBe('idle');
	});

	it('flushes at once and reports whether everything landed', async () => {
		const t = setup();
		await t.edit('now');
		expect(await t.autosave.flush()).toBe(true);
		expect(t.saves).toEqual(['now']);

		t.persist.mockRejectedValueOnce(new Error('refused'));
		await t.edit('later');
		expect(await t.autosave.flush()).toBe(false);
		expect(t.autosave.status.value).toBe('error');
	});

	it('waits for a save in flight, and commits open text, before a flush saves', async () => {
		const t = setup();
		const flight = t.hold();
		await t.edit('background');
		await vi.advanceTimersByTimeAsync(1500);
		t.open.value = true;
		await nextTick();
		expect(t.autosave.status.value).toBe('editing');
		const flushed = t.autosave.flush();
		t.release();
		flight.resolve();
		expect(await flushed).toBe(true);
		expect(t.saves).toEqual(['background', 'from the text editor']);
	});

	it('holds background saves while a final action runs; its own save goes through', async () => {
		const t = setup();
		await t.edit('before');
		const done = t.autosave.runAction(async () => {
			await vi.advanceTimersByTimeAsync(5000);
			expect(t.persist).not.toHaveBeenCalled();
			return t.autosave.flush();
		});
		expect(await done).toBe(true);
		expect(t.saves).toEqual(['before']);
		await t.edit('after');
		await vi.advanceTimersByTimeAsync(1500);
		expect(t.saves).toEqual(['before', 'after']);
	});
});

describe('useDraftAutosave: leaving', () => {
	it('commits open text and writes its copy before it decides, then lets the page go', async () => {
		const t = setup();
		t.open.value = true;
		await nextTick();
		const verdict = t.autosave.leave.request('/elsewhere');
		expect(await verdict).toBe(true);
		expect(t.text.value).toBe('from the text editor');
		expect(t.autosave.onDevice.value).toBe(true);
		expect(t.persist).not.toHaveBeenCalled();
	});

	it('asks when the device cannot keep the text, and holds the save while it asks', async () => {
		const t = setup({ store: createEditorDraftStore(memoryDriver(false)) });
		t.open.value = true;
		await nextTick();
		expect(await t.autosave.leave.request('/elsewhere')).toBe(false);
		expect(t.autosave.leave.choosing.value).toBe(true);
		expect(t.autosave.atRisk.value).toBe(true);
		await vi.advanceTimersByTimeAsync(5000);
		expect(t.persist).not.toHaveBeenCalled();
		// Stay: autosave carries on.
		t.autosave.leave.cancel();
		await vi.advanceTimersByTimeAsync(1500);
		expect(t.saves).toEqual(['from the text editor']);
	});

	it('stops waiting for a copy write that hangs and asks', async () => {
		const driver = memoryDriver();
		driver.set = () => new Promise(() => {});
		const t = setup({}, { driver });
		await t.edit('typed');
		const verdict = t.autosave.leave.request('/elsewhere');
		await vi.advanceTimersByTimeAsync(999);
		let decided: boolean | null = null;
		void verdict.then((value) => (decided = value));
		await settle();
		expect(decided).toBeNull();
		await vi.advanceTimersByTimeAsync(1);
		expect(await verdict).toBe(false);
		expect(t.autosave.atRisk.value).toBe(true);
	});

	it("goes where the prompt's Save was asked to, once it landed", async () => {
		const t = setup({ store: createEditorDraftStore(memoryDriver(false)) });
		await t.edit('typed');
		expect(await t.autosave.leave.request('/elsewhere')).toBe(false);
		expect(await t.autosave.leave.save()).toBe('/elsewhere');
		expect(t.saves).toEqual(['typed']);
		// That navigation passes the guard.
		expect(await t.autosave.leave.request('/elsewhere')).toBe(true);
	});

	it('stays when Save fails, and when the person stays before it lands', async () => {
		const t = setup({ store: createEditorDraftStore(memoryDriver(false)) });
		t.persist.mockRejectedValueOnce(new Error('offline'));
		await t.edit('typed');
		await t.autosave.leave.request('/elsewhere');
		expect(await t.autosave.leave.save()).toBeNull();
		expect(t.autosave.leave.choosing.value).toBe(true);

		const flight = t.hold();
		const saving = t.autosave.leave.save();
		await settle();
		t.autosave.leave.cancel();
		flight.resolve();
		expect(await saving).toBeNull();
		expect(t.autosave.leave.choosing.value).toBe(false);
	});
});

describe('useDraftAutosave: Discard and closing', () => {
	it('saves what is pending, and writes its copy, when the editor goes away', async () => {
		const t = setup();
		await t.edit('leaving');
		t.scope.stop();
		await settle();
		expect(t.saves).toEqual(['leaving']);
	});

	it('saves and keeps nothing it discarded, also when the editor goes away right after', async () => {
		const t = setup({ store: createEditorDraftStore(memoryDriver(false)) });
		await t.edit('discarded');
		await t.autosave.leave.request('/elsewhere');
		expect(t.autosave.leave.discard()).toBe('/elsewhere');
		t.scope.stop();
		await vi.advanceTimersByTimeAsync(5000);
		expect(t.persist).not.toHaveBeenCalled();
	});

	it('deletes a copy whose write was on its way when the draft was discarded', async () => {
		const t = setup();
		await t.edit('discarded');
		await vi.advanceTimersByTimeAsync(300);
		t.autosave.discard();
		await settle();
		expect(t.driver.data.has(KEY)).toBe(false);
		expect(t.autosave.atRisk.value).toBe(false);
	});

	it('saves again after an edit that follows a discard', async () => {
		const t = setup();
		await t.edit('discarded');
		t.autosave.discard();
		await t.edit('kept');
		await vi.advanceTimersByTimeAsync(1500);
		expect(t.saves).toEqual(['kept']);
	});

	it("keeps each tab's copy apart, so neither loses its edits to the other", async () => {
		const driver = memoryDriver();
		const a = setup({}, { driver, tab: 'tab-a' });
		const b = setup({}, { driver, tab: 'tab-b' });
		a.hold();
		b.hold();
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
});

describe('useDraftAutosave: copies left behind', () => {
	const OTHER = editorDraftKey(SCOPE, 'tab-old.1');
	const leftBehind = (text: string, base = 3) => ({
		v: 2,
		token: 'tab-old.1#7',
		seq: 7,
		savedAt: Date.now() - 60_000,
		base,
		data: { text },
	});

	it('offers a copy, also one built on the revision the server holds, and applies nothing', async () => {
		const driver = memoryDriver();
		driver.data.set(OTHER, leftBehind('offline edit'));
		const t = setup({}, { driver });
		await settle();
		await vi.advanceTimersByTimeAsync(5000);
		expect(t.autosave.recovery.pending.value?.data).toEqual({ text: 'offline edit' });
		expect(t.text.value).toBe('saved');
		expect(t.persist).not.toHaveBeenCalled();
	});

	it('restores a copy as an edit, keeps its own copy, then retires the one left behind', async () => {
		const driver = memoryDriver();
		driver.data.set(OTHER, leftBehind('offline edit'));
		const t = setup({}, { driver });
		await settle();
		t.autosave.recovery.restore();
		expect(t.text.value).toBe('offline edit');
		await settle();
		expect(driver.data.get(KEY)).toMatchObject({ data: { text: 'offline edit' } });
		expect(driver.data.has(OTHER)).toBe(false);
		await vi.advanceTimersByTimeAsync(1500);
		expect(t.saves).toEqual(['offline edit']);
		expect(t.persist.mock.calls[0]?.[0]).toMatchObject({ baseRevision: 3 });
	});

	it('keeps the copy left behind when this editor could not keep the restored one', async () => {
		const driver = memoryDriver();
		driver.data.set(OTHER, leftBehind('offline edit'));
		const t = setup({}, { driver });
		await settle();
		const set = driver.set;
		driver.set = async (key, value) => {
			if (key === KEY) throw new Error('QuotaExceededError');
			await set(key, value);
		};
		t.persist.mockRejectedValue(new Error('offline'));
		t.autosave.recovery.restore();
		await settle();
		await vi.advanceTimersByTimeAsync(1500);
		await settle();
		expect(driver.data.has(OTHER)).toBe(true);
	});

	it('deletes a copy that says what the editor shows, and discards an offered one on request', async () => {
		const driver = memoryDriver();
		driver.data.set(OTHER, leftBehind('saved'));
		setup({}, { driver });
		await settle();
		expect(driver.data.has(OTHER)).toBe(false);

		driver.data.set(OTHER, leftBehind('offline edit'));
		const t = setup({}, { driver, tab: 'tab-c' });
		await settle();
		t.autosave.recovery.discard();
		await settle();
		expect(driver.data.has(OTHER)).toBe(false);
		expect(t.autosave.recovery.pending.value).toBeNull();
	});

	it('offers, and never deletes, a copy whose editor may still be open', async () => {
		const driver = memoryDriver();
		driver.data.set(OTHER, leftBehind('saved'));
		const t = setup({}, { driver, locks: false });
		await settle();
		expect(driver.data.has(OTHER)).toBe(true);
		driver.data.set(OTHER, leftBehind('their edit'));
		const second = setup({}, { driver, tab: 'tab-c', locks: false });
		await settle();
		expect(second.autosave.recovery.pending.value?.data).toEqual({ text: 'their edit' });
		second.autosave.recovery.restore();
		await settle();
		second.autosave.recovery.discard();
		await settle();
		expect(driver.data.has(OTHER)).toBe(true);
		expect(t.text.value).toBe('saved');
	});

	it('applies nothing when the editor closed while the copies were read', async () => {
		const driver = memoryDriver();
		driver.data.set(OTHER, leftBehind('offline edit'));
		const keys = deferred();
		const list = driver.keys;
		driver.keys = async () => {
			await keys.promise;
			return list();
		};
		const t = setup({}, { driver });
		t.scope.stop();
		keys.resolve();
		await settle();
		expect(t.autosave.recovery.pending.value).toBeNull();
		t.autosave.recovery.restore();
		expect(t.text.value).toBe('saved');
	});
});
