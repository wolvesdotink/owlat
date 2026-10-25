/**
 * The draft autosave runner (`useDraftAutosave.ts`): it runs what the
 * session (`utils/draftSession.ts`) decides against real timers and a save,
 * and reports the outcomes back. Fake timers only; nothing waits on the real
 * clock, and no wait counts microtasks: a test awaits the milestone it
 * depends on (an event the session took, a state it reached). The editor is
 * one text field; nothing is kept on the device.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, reactive, ref, watch } from 'vue';
import { until } from '~/__tests__/until';
import type { DraftEvent, DraftLive } from '~/utils/draftSession';
import { useDraftAutosave, type DraftAutosaveOptions } from '../useDraftAutosave';

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

const fp = (value: unknown) => JSON.stringify(value);

/**
 * An editor with one text field on revision 3. The test plays the editor's
 * binding: it loads the draft and reports each edit.
 */
function setup(over: Partial<DraftAutosaveOptions> = {}) {
	const events = reactive<DraftEvent['type'][]>([]);
	const text = ref('saved');
	const serverText = ref('saved');
	const enabled = ref(true);
	const online = ref(true);
	const open = ref(false);
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
		const draft = useDraftAutosave({
			enabled: () => enabled.value,
			read: () => ({ text: fp(text.value) }),
			persist,
			inline: () => open.value,
			commitInline: () => {
				open.value = false;
				text.value = 'from the text editor';
			},
			online: () => online.value,
			observe: (event) => events.push(event.type),
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
		/** Resolves once the session took its `n`-th event of `type` since setup. */
		after: (type: DraftEvent['type'], n = 1) =>
			until(() => events.filter((event) => event === type).length >= n),
		text,
		serverText,
		enabled,
		online,
		open,
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
		expect(t.autosave.status.value).toBe('idle');
		expect(t.autosave.atRisk.value).toBe(false);
	});

	it('saves the latest draft once the edits pause', async () => {
		const t = setup();
		await t.edit('a');
		await vi.advanceTimersByTimeAsync(1000);
		await t.edit('ab');
		await vi.advanceTimersByTimeAsync(1000);
		expect(t.persist).not.toHaveBeenCalled();
		expect(t.autosave.status.value).toBe('saving');
		expect(t.autosave.atRisk.value).toBe(true);

		await vi.advanceTimersByTimeAsync(600);
		expect(t.saves).toEqual(['ab']);
		expect(t.persist.mock.calls[0]?.[0]).toMatchObject({ baseRevision: 3 });
		expect(t.autosave.status.value).toBe('saved');
		expect(t.autosave.savedAt.value).not.toBeNull();
		expect(t.autosave.atRisk.value).toBe(false);
	});

	it('saves an edit made while a save is in flight after it, on the revision it stored', async () => {
		const t = setup();
		const flight = t.hold();
		await t.edit('one');
		await vi.advanceTimersByTimeAsync(1500);
		expect(t.saves).toEqual(['one']);
		// On its way is not saved.
		expect(t.autosave.atRisk.value).toBe(true);

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

	it('keeps the edit and its guard after a failed save, shows the failure and retries', async () => {
		const t = setup();
		t.persist.mockRejectedValueOnce(new Error('refused'));
		await t.edit('typed');
		await vi.advanceTimersByTimeAsync(1500);
		await t.after('save-failed');
		expect(t.autosave.status.value).toBe('error');
		expect(t.autosave.error.value).toBeInstanceOf(Error);
		expect(t.text.value).toBe('typed');
		expect(t.autosave.atRisk.value).toBe(true);
		expect(t.autosave.leave.isAtRisk()).toBe(true);

		t.autosave.retry();
		await vi.advanceTimersByTimeAsync(0);
		await t.after('saved');
		expect(t.persist).toHaveBeenCalledTimes(2);
		expect(t.serverText.value).toBe('typed');
		expect(t.autosave.status.value).toBe('saved');
		expect(t.autosave.atRisk.value).toBe(false);
	});

	it('reports offline and not saved, and saves when the backend is back', async () => {
		const t = setup();
		t.online.value = false;
		const flight = t.hold();
		await t.edit('offline edit');
		await vi.advanceTimersByTimeAsync(1500);
		expect(t.autosave.status.value).toBe('offline');
		expect(t.autosave.atRisk.value).toBe(true);

		t.online.value = true;
		flight.resolve();
		await vi.advanceTimersByTimeAsync(0);
		await t.after('saved');
		expect(t.autosave.status.value).toBe('saved');
		expect(t.autosave.atRisk.value).toBe(false);
	});

	it('follows the browser going offline and back by default', async () => {
		const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
		try {
			const t = setup({ online: undefined });
			const flight = t.hold();
			await t.edit('typed offline');
			onLine.mockReturnValue(false);
			window.dispatchEvent(new Event('offline'));
			await nextTick();
			expect(t.autosave.state.value.online).toBe(false);
			await vi.advanceTimersByTimeAsync(1500);
			expect(t.autosave.status.value).toBe('offline');

			onLine.mockReturnValue(true);
			window.dispatchEvent(new Event('online'));
			await nextTick();
			expect(t.autosave.state.value.online).toBe(true);
			t.release();
			flight.resolve();
			await t.after('saved');
			expect(t.autosave.status.value).toBe('saved');
			t.scope.stop();
		} finally {
			onLine.mockRestore();
		}
	});

	it('does nothing while autosave does not apply', async () => {
		const t = setup();
		t.enabled.value = false;
		await t.edit('published');
		await vi.advanceTimersByTimeAsync(5000);
		expect(t.persist).not.toHaveBeenCalled();
		expect(t.autosave.status.value).toBe('idle');
		expect(t.autosave.atRisk.value).toBe(false);
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

	it('lets a final action dispatch only while the editor shows what the server holds', async () => {
		const t = setup();
		await t.edit('before');
		const asked: boolean[] = [];
		const done = t.autosave.runAction(async (current) => {
			await t.autosave.flush();
			asked.push(current());
			// Edited after the action's save: what it would dispatch is not what is shown.
			await t.edit('typed during the action');
			asked.push(current());
			return asked.at(-1)!;
		});
		expect(await done).toBe(false);
		expect(asked).toEqual([true, false]);
		// Background saving carries on with the newer edit.
		await vi.advanceTimersByTimeAsync(1500);
		expect(t.saves).toEqual(['before', 'typed during the action']);
	});
});

describe('useDraftAutosave: a live session', () => {
	/** A live editor whose session state the test sets; only `readLive` reports it. */
	function setupLive(initial: Partial<DraftLive>) {
		const live = ref<DraftLive>({
			sessionId: 's1',
			base: 2,
			sharedPending: false,
			unsent: false,
			alone: false,
			...initial,
		});
		const t = setup({ read: undefined, readLive: () => live.value });
		t.autosave.dispatch({ type: 'live', live: live.value });
		return { ...t, live };
	}

	it('reads the session when a flush ends, not a report from before its save', async () => {
		const t = setupLive({ sharedPending: true });
		t.persist.mockImplementationOnce(async () => {
			// The server wrote the session; nothing tells the runner but `readLive`.
			t.live.value = { ...t.live.value, sharedPending: false };
			return { revision: 4 };
		});
		expect(await t.autosave.flush()).toBe(true);
		expect(t.persist).toHaveBeenCalledOnce();
		expect(t.autosave.atRisk.value).toBe(false);
	});

	it('gives up, unsaved, when the session keeps holding what the email does not', async () => {
		const t = setupLive({ sharedPending: true });
		expect(await t.autosave.flush()).toBe(false);
		expect(t.persist).toHaveBeenCalledTimes(3);
		expect(t.autosave.atRisk.value).toBe(true);
		expect(t.autosave.status.value).toBe('unsaved');
		expect(await t.autosave.leave.request('/elsewhere')).toBe(false);
	});
});

describe('useDraftAutosave: leaving', () => {
	it('commits open text before it decides, and asks while it is not saved', async () => {
		const t = setup();
		t.open.value = true;
		await nextTick();
		expect(await t.autosave.leave.request('/elsewhere')).toBe(false);
		expect(t.text.value).toBe('from the text editor');
		expect(t.autosave.leave.choosing.value).toBe(true);
		expect(t.autosave.atRisk.value).toBe(true);
		// The prompt holds the background save while it asks.
		await vi.advanceTimersByTimeAsync(5000);
		expect(t.persist).not.toHaveBeenCalled();
		// Stay: autosave carries on.
		t.autosave.leave.cancel();
		await vi.advanceTimersByTimeAsync(1500);
		expect(t.saves).toEqual(['from the text editor']);
		// Saved: the page goes without asking.
		expect(await t.autosave.leave.request('/elsewhere')).toBe(true);
	});

	it("goes where the prompt's Save was asked to, once it landed", async () => {
		const t = setup();
		await t.edit('typed');
		expect(await t.autosave.leave.request('/elsewhere')).toBe(false);
		expect(await t.autosave.leave.save()).toBe('/elsewhere');
		expect(t.saves).toEqual(['typed']);
		// That navigation passes the guard.
		expect(await t.autosave.leave.request('/elsewhere')).toBe(true);
	});

	it('stays when Save fails, and when the person stays before it lands', async () => {
		const t = setup();
		t.persist.mockRejectedValueOnce(new Error('offline'));
		await t.edit('typed');
		await t.autosave.leave.request('/elsewhere');
		expect(await t.autosave.leave.save()).toBeNull();
		expect(t.autosave.leave.choosing.value).toBe(true);
		expect(t.autosave.atRisk.value).toBe(true);

		const flight = t.hold();
		const saving = t.autosave.leave.save();
		await until(() => t.autosave.state.value.flight !== null);
		t.autosave.leave.cancel();
		flight.resolve();
		expect(await saving).toBeNull();
		expect(t.autosave.leave.choosing.value).toBe(false);
	});
});

describe('useDraftAutosave: Discard and closing', () => {
	it('saves nothing when the editor goes away, whatever is pending', async () => {
		const t = setup();
		await t.edit('leaving');
		t.scope.stop();
		await t.after('close');
		await vi.advanceTimersByTimeAsync(5000);
		expect(t.persist).not.toHaveBeenCalled();
	});

	it('saves nothing it discarded, also when the editor goes away right after', async () => {
		const t = setup();
		await t.edit('discarded');
		await t.autosave.leave.request('/elsewhere');
		expect(t.autosave.leave.discard()).toBe('/elsewhere');
		expect(t.autosave.atRisk.value).toBe(false);
		t.scope.stop();
		await vi.advanceTimersByTimeAsync(5000);
		expect(t.persist).not.toHaveBeenCalled();
	});

	it('saves again after an edit that follows a discard', async () => {
		const t = setup();
		await t.edit('discarded');
		t.autosave.discard();
		await t.edit('kept');
		await vi.advanceTimersByTimeAsync(1500);
		expect(t.saves).toEqual(['kept']);
	});
});
