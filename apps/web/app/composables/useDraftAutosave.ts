import {
	computed,
	getCurrentInstance,
	getCurrentScope,
	nextTick,
	onMounted,
	onScopeDispose,
	onUnmounted,
	ref,
	shallowRef,
	watch,
	type ComputedRef,
	type Ref,
	type WatchSource,
} from 'vue';
import { backendConnectionPhase } from '~/lib/backendConnection';
import {
	editorDraftKey,
	getEditorDraftStore,
	type EditorDraftStore,
} from '~/utils/editorDraftStore';
import { getEditorDraftWriters, type EditorDraftWriters } from '~/utils/editorDraftWriters';

/**
 * Draft autosave: the background save behind the draft editors (Email
 * template, campaign), and the device copy that covers the time until a save
 * lands.
 *
 * - Every edit restarts a short pause; when it runs out the draft is saved.
 *   One save runs at a time, and an edit made while it runs is saved after it.
 * - Every edit is also written to the device (`editorDraftStore.ts`) a moment
 *   later, under this editor's own key, and that copy is deleted once a save
 *   of the same draft landed. The editors read copies left behind back when
 *   they open (`useDraftRecovery.ts`).
 * - `flush` saves now and reports whether nothing is left unsaved: Publish,
 *   Schedule and Send call it before they act, so they never act on a draft
 *   the server has not got.
 * - `atRisk` is what leaving would lose: an edit neither saved nor on the
 *   device, or a choice only the device can hold whose copy could not be
 *   written. The page arms its leave guards with it instead of with "dirty".
 * - `cancel` is Discard: nothing of the current edits is saved or kept, not
 *   even when the editor goes away right after.
 * - While a save-or-discard prompt is open (`held`), nothing saves in the
 *   background: a Discard chosen there must not find its edits already sent.
 *
 * Save failures are shown by the status, not by a toast per attempt; the next
 * edit, `retry`, or the backend coming back tries again. While the backend is
 * unreachable the Convex client holds the mutation and sends it on reconnect,
 * so a save in flight while offline is not a failure, only late.
 */

export type DraftSaveStatus =
	| 'idle'
	| 'editing'
	| 'saving'
	| 'offline'
	| 'saved'
	/** Saved, but a choice only the device holds could not be written to it. */
	| 'unkept'
	| 'error';

export interface DraftAutosaveMirror<T> {
	/**
	 * The draft's device copies (`editorDraftScope`); null while there is
	 * none (not signed in yet). This editor's copy is its own key under it.
	 */
	scope: () => string | null;
	/** The draft as it is now, read synchronously. */
	snapshot: () => T;
	/** The server state the draft is built on (revision, `updatedAt`). */
	base: () => number | null;
	/**
	 * Keep the copy after a save landed, because it holds choices the server
	 * does not store for a draft (the campaign's schedule). Rewritten on the
	 * new base instead of deleted.
	 */
	keepAfterSave?: (snapshot: T) => boolean;
}

export interface DraftAutosaveOptions<T> {
	/** Autosave applies to what is open (a loaded draft). */
	enabled: () => boolean;
	/**
	 * Saving has to wait (a conflict choice is open, Send is running). Edits
	 * still reach the device copy; the save runs once this turns false.
	 */
	paused?: () => boolean;
	/**
	 * A prompt asks whether to save or discard: background saves wait for the
	 * answer. `flush` (its Save) still saves, and so does leaving without one.
	 */
	held?: () => boolean;
	/** The draft differs from what the server holds. */
	dirty: () => boolean;
	/** Values that change with every edit. */
	changes: WatchSource<unknown>[];
	/**
	 * Persist the draft as it is now. Read it synchronously before the first
	 * `await`. Reject when it did not land; the error is kept for the status.
	 */
	save: () => Promise<void>;
	/** Typing the draft cannot see yet (the email builder's open text editor). */
	uncommitted?: () => boolean;
	/** Make that typing part of the draft (close the text editor). */
	commit?: () => void;
	mirror?: DraftAutosaveMirror<T>;
	/** How long the editor waits after the last edit; default 1500 ms. */
	debounceMs?: number;
	/** Whether the backend is reachable; default: the app's connection state. */
	online?: () => boolean;
	/** Injected in tests; defaults to the page's IndexedDB store. */
	store?: EditorDraftStore;
	/** Injected in tests; defaults to the page's writers. */
	writers?: EditorDraftWriters;
}

export interface DraftAutosave {
	status: ComputedRef<DraftSaveStatus>;
	/** When the last save landed. */
	savedAt: Readonly<Ref<number | null>>;
	/** The last save's failure, until a save lands. */
	error: Readonly<Ref<unknown>>;
	/** The current draft is on this device. */
	onDevice: ComputedRef<boolean>;
	/** Counts this editor's edits (recovery checks none came in meanwhile). */
	edits: Readonly<Ref<number>>;
	/** Write the device copy now; resolves whether it holds the current draft. */
	keep: () => Promise<boolean>;
	/**
	 * Leaving now would lose an edit: arm the leave guards with this. Typing
	 * the draft cannot see yet is not counted: the leave guard runs
	 * `commitBeforeLeaving` before it reads this, and closing the tab is
	 * guarded here.
	 */
	atRisk: ComputedRef<boolean>;
	/**
	 * Make typing the draft cannot see yet part of it and write its device
	 * copy, so `atRisk` covers it. A leave guard awaits this (and the watchers
	 * that feed it) before it decides; reading `atRisk` first would let the
	 * page go with that text kept nowhere. Returns nothing when no text is
	 * open, so the guard can decide at once.
	 */
	commitBeforeLeaving: () => Promise<void> | undefined;
	/** Save now; resolves true when nothing is left unsaved. */
	flush: () => Promise<boolean>;
	/** Retry a failed save. */
	retry: () => void;
	/**
	 * Discard: drop the pending save and the device copy, and save nothing of
	 * the current edits, also when the editor goes away. The next edit saves
	 * again.
	 */
	cancel: () => void;
}

const DEFAULT_DEBOUNCE_MS = 1500;
/** How soon after an edit the device copy is written. */
const MIRROR_DELAY_MS = 300;
/** Saves a flush runs before giving up on an editor that keeps changing. */
const FLUSH_ROUNDS = 3;
/** How long leaving waits for the device copy of committed text before it asks instead. */
const LEAVE_WRITE_WAIT_MS = 1000;

const defaultOnline = () =>
	backendConnectionPhase.value === null &&
	(typeof navigator === 'undefined' || navigator.onLine !== false);

export function useDraftAutosave<T>(opts: DraftAutosaveOptions<T>): DraftAutosave {
	const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
	const online = opts.online ?? defaultOnline;
	const mirror = opts.mirror;
	const store = mirror ? (opts.store ?? getEditorDraftStore()) : null;
	const writer = mirror ? (opts.writers ?? getEditorDraftWriters()).open() : null;
	const canSave = () => opts.enabled() && opts.paused?.() !== true;
	const canAutosave = () => canSave() && opts.held?.() !== true;

	/** Bumped by every edit; a save or device write covers the edits up to its number. */
	const edits = ref(0);
	const savedEdits = ref(0);
	const mirroredEdits = ref(-1);
	const inFlight = ref(false);
	const timerPending = ref(false);
	const savedAt = ref<number | null>(null);
	const error = shallowRef<unknown>(null);
	/** Device-only choices a save left to the device copy, which failed to write. */
	const deviceShortfall = ref(false);
	/** That copy is being written: until it commits, the choices are nowhere else. */
	const keeping = ref(false);
	/** The edit count `cancel` discarded; nothing up to it is saved or kept. */
	let discarded = -1;
	const isDiscarded = () => edits.value === discarded;

	let saveTimer: ReturnType<typeof setTimeout> | null = null;
	let mirrorTimer: ReturnType<typeof setTimeout> | null = null;
	let running: Promise<void> | null = null;
	/** The `savedAt` of the device copy this editor wrote last. */
	let mirrorStamp: { key: string; savedAt: number } | null = null;
	let disposed = false;

	const clearSaveTimer = () => {
		if (saveTimer !== null) clearTimeout(saveTimer);
		saveTimer = null;
		timerPending.value = false;
	};
	const clearMirrorTimer = () => {
		if (mirrorTimer !== null) clearTimeout(mirrorTimer);
		mirrorTimer = null;
	};

	const schedule = (delay = debounceMs) => {
		clearSaveTimer();
		if (disposed || isDiscarded()) return;
		timerPending.value = true;
		saveTimer = setTimeout(() => {
			saveTimer = null;
			timerPending.value = false;
			void run(true);
		}, delay);
	};

	// ── Device copy ─────────────────────────────────────────────────────
	/** Resolves whether the copy was written. */
	const writeMirror = async (keep = false): Promise<boolean> => {
		clearMirrorTimer();
		const scope = mirror?.scope();
		// A change that left nothing unsaved (the draft loading) needs no copy.
		if (!mirror || !store || !writer || !scope || isDiscarded() || (!keep && !opts.dirty())) {
			return false;
		}
		const key = editorDraftKey(scope, writer.id);
		const covers = edits.value;
		const copy = {
			v: 1 as const,
			savedAt: Date.now(),
			base: mirror.base(),
			data: mirror.snapshot(),
		};
		mirrorStamp = { key, savedAt: copy.savedAt };
		const written = await store.write(key, copy);
		// Discarded while it was written: the copy goes too.
		if (discarded === covers) {
			if (written) await store.removeIf(key, copy.savedAt);
			return false;
		}
		if (written && covers === edits.value) mirroredEdits.value = covers;
		return written;
	};
	const scheduleMirror = () => {
		clearMirrorTimer();
		if (!mirror || disposed) return;
		mirrorTimer = setTimeout(() => void writeMirror(), MIRROR_DELAY_MS);
	};
	/** A save of everything up to now landed: retire the device copy. */
	const settleMirror = async () => {
		if (!mirror || !store) return;
		clearMirrorTimer();
		if (mirror.keepAfterSave?.(mirror.snapshot())) {
			keeping.value = true;
			try {
				const kept = await writeMirror(true);
				deviceShortfall.value = !kept && !isDiscarded();
			} finally {
				keeping.value = false;
			}
			return;
		}
		deviceShortfall.value = false;
		const stamp = mirrorStamp;
		mirrorStamp = null;
		if (stamp) await store.removeIf(stamp.key, stamp.savedAt);
	};

	// ── Saving ──────────────────────────────────────────────────────────
	/** `auto`: a background save, which waits while a prompt is open. */
	const run = (auto = false): Promise<void> => {
		if (running) return running;
		if (!(auto ? canAutosave() : canSave()) || !opts.dirty() || isDiscarded()) {
			return Promise.resolve();
		}
		const covers = edits.value;
		inFlight.value = true;
		running = (async () => {
			try {
				await opts.save();
				error.value = null;
				savedAt.value = Date.now();
				savedEdits.value = Math.max(savedEdits.value, covers);
				if (!opts.dirty() && edits.value === covers) await settleMirror();
			} catch (failure) {
				error.value = failure;
			} finally {
				inFlight.value = false;
				running = null;
			}
			// Edited while it ran: save that too (a failure waits for the next
			// edit, a retry or the reconnect instead of looping).
			if (!error.value && canAutosave() && opts.dirty() && edits.value !== covers) schedule();
		})();
		return running;
	};

	watch(opts.changes, () => {
		if (!opts.enabled()) return;
		edits.value += 1;
		scheduleMirror();
		if (canAutosave()) schedule();
	});

	// Became savable with something unsaved (the draft finished loading, a
	// conflict was resolved, a prompt closed, the backend came back): save it.
	watch(
		() => canAutosave() && opts.dirty() && online(),
		(ready) => {
			if (ready && !inFlight.value && !timerPending.value) schedule();
		}
	);

	const flush = async (): Promise<boolean> => {
		if (opts.uncommitted?.()) {
			opts.commit?.();
			// The commit reaches the draft (and its dirty flag) through watchers.
			await nextTick();
		}
		clearSaveTimer();
		for (let round = 0; round < FLUSH_ROUNDS; round++) {
			if (running) await running;
			if (!canSave() || !opts.dirty()) break;
			error.value = null;
			await run();
			if (error.value) return false;
		}
		return !opts.dirty() && !opts.uncommitted?.();
	};

	const retry = () => {
		error.value = null;
		schedule(0);
	};

	const cancel = () => {
		clearSaveTimer();
		clearMirrorTimer();
		error.value = null;
		deviceShortfall.value = false;
		keeping.value = false;
		discarded = edits.value;
		const stamp = mirrorStamp;
		mirrorStamp = null;
		if (stamp && store) void store.removeIf(stamp.key, stamp.savedAt);
	};

	// ── State ───────────────────────────────────────────────────────────
	// This editor's own edits not saved yet (unsaved changes it did not make,
	// another co-editor's, are theirs to save).
	const pending = computed(
		() => (opts.dirty() && savedEdits.value !== edits.value) || inFlight.value || timerPending.value
	);
	const onDevice = computed(
		() => store?.persistent === true && mirroredEdits.value === edits.value
	);
	const atRisk = computed(
		() =>
			opts.enabled() &&
			!onDevice.value &&
			((opts.dirty() && savedEdits.value !== edits.value) || deviceShortfall.value || keeping.value)
	);
	const status = computed<DraftSaveStatus>(() => {
		if (!opts.enabled()) return 'idle';
		if (opts.uncommitted?.()) return 'editing';
		if (error.value && !inFlight.value) return 'error';
		if (pending.value) return online() ? 'saving' : 'offline';
		if (deviceShortfall.value && !onDevice.value) return 'unkept';
		return savedAt.value === null ? 'idle' : 'saved';
	});

	// Closing the tab: the browser asks only while an edit would be lost.
	const onBeforeUnload = (event: BeforeUnloadEvent) => {
		if (!atRisk.value && !(opts.enabled() && opts.uncommitted?.())) return;
		event.preventDefault();
		event.returnValue = '';
	};
	if (getCurrentInstance()) {
		onMounted(() => window.addEventListener('beforeunload', onBeforeUnload));
		onUnmounted(() => window.removeEventListener('beforeunload', onBeforeUnload));
	}

	// Leaving the editor: what is still pending is saved now (the request
	// outlives the page within the app) and its device copy written, unless
	// it was discarded. The copy is then left behind for recovery.
	if (getCurrentScope())
		onScopeDispose(() => {
			const leaving =
				opts.enabled() &&
				!isDiscarded() &&
				(timerPending.value || mirrorTimer !== null || opts.dirty());
			if (leaving) {
				if (mirrorTimer !== null) void writeMirror();
				clearSaveTimer();
				void run();
			}
			clearSaveTimer();
			clearMirrorTimer();
			disposed = true;
			writer?.close();
		});

	const keep = async (): Promise<boolean> => {
		// The edit that asks for it reaches the counters through watchers.
		await nextTick();
		await writeMirror();
		return onDevice.value;
	};

	const commitBeforeLeaving = () => {
		if (!opts.enabled() || !opts.uncommitted?.()) return undefined;
		opts.commit?.();
		// A write that hangs (storage blocked by another tab) must not hold the
		// page: past the wait, `atRisk` still counts the text and the guard asks.
		let timer: ReturnType<typeof setTimeout> | undefined;
		const waited = new Promise<void>((resolve) => {
			timer = setTimeout(resolve, LEAVE_WRITE_WAIT_MS);
		});
		return Promise.race([keep(), waited]).then(() => clearTimeout(timer));
	};

	return {
		status,
		savedAt,
		error,
		onDevice,
		edits,
		keep,
		atRisk,
		commitBeforeLeaving,
		flush,
		retry,
		cancel,
	};
}
