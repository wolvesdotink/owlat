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
import { onBeforeRouteLeave } from 'vue-router';
import { backendConnectionPhase } from '~/lib/backendConnection';
import { getEditorDraftStore, type EditorDraftStore } from '~/utils/editorDraftStore';

/**
 * Draft autosave: the background save behind the draft editors (Email
 * template, campaign), and the device copy that covers the time until a save
 * lands.
 *
 * - Every edit restarts a short pause; when it runs out the draft is saved.
 *   One save runs at a time, and an edit made while it runs is saved after it.
 * - Every edit is also written to the device (`editorDraftStore.ts`) a moment
 *   later, and that copy is deleted once a save of the same draft landed. The
 *   editors read it back when they open (`useDraftRecovery.ts`).
 * - `flush` saves now and reports whether nothing is left unsaved: Publish,
 *   Schedule and Send call it before they act, so they never act on a draft
 *   the server has not got.
 * - `atRisk` is what leaving would lose: an edit neither saved nor on the
 *   device. The page arms its leave guards with it instead of with "dirty".
 *
 * Save failures are shown by the status, not by a toast per attempt; the next
 * edit, `retry`, or the backend coming back tries again. While the backend is
 * unreachable the Convex client holds the mutation and sends it on reconnect,
 * so a save in flight while offline is not a failure, only late.
 */

export type DraftSaveStatus = 'idle' | 'editing' | 'saving' | 'offline' | 'saved' | 'error';

export interface DraftAutosaveMirror<T> {
	/** The device copy's key; null while there is none (not signed in yet). */
	key: () => string | null;
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
}

export interface DraftAutosave {
	status: ComputedRef<DraftSaveStatus>;
	/** When the last save landed. */
	savedAt: Readonly<Ref<number | null>>;
	/** The last save's failure, until a save lands. */
	error: Readonly<Ref<unknown>>;
	/** The current draft is on this device. */
	onDevice: ComputedRef<boolean>;
	/**
	 * Leaving now would lose an edit: arm the leave guards with this. Typing
	 * the draft cannot see yet is not counted: leaving within the app commits
	 * it first, and closing the tab is guarded here.
	 */
	atRisk: ComputedRef<boolean>;
	/** Save now; resolves true when nothing is left unsaved. */
	flush: () => Promise<boolean>;
	/** Retry a failed save. */
	retry: () => void;
	/** Drop the pending save and device copy (the draft is being discarded). */
	cancel: () => void;
}

const DEFAULT_DEBOUNCE_MS = 1500;
/** How soon after an edit the device copy is written. */
const MIRROR_DELAY_MS = 300;
/** Saves a flush runs before giving up on an editor that keeps changing. */
const FLUSH_ROUNDS = 3;

const defaultOnline = () =>
	backendConnectionPhase.value === null &&
	(typeof navigator === 'undefined' || navigator.onLine !== false);

export function useDraftAutosave<T>(opts: DraftAutosaveOptions<T>): DraftAutosave {
	const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
	const online = opts.online ?? defaultOnline;
	const mirror = opts.mirror;
	const store = mirror ? (opts.store ?? getEditorDraftStore()) : null;
	const canSave = () => opts.enabled() && opts.paused?.() !== true;

	/** Bumped by every edit; a save or device write covers the edits up to its number. */
	const edits = ref(0);
	const savedEdits = ref(0);
	const mirroredEdits = ref(-1);
	const inFlight = ref(false);
	const timerPending = ref(false);
	const savedAt = ref<number | null>(null);
	const error = shallowRef<unknown>(null);

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
		if (disposed) return;
		timerPending.value = true;
		saveTimer = setTimeout(() => {
			saveTimer = null;
			timerPending.value = false;
			void run();
		}, delay);
	};

	// ── Device copy ─────────────────────────────────────────────────────
	const writeMirror = async (keep = false) => {
		clearMirrorTimer();
		const key = mirror?.key();
		// A change that left nothing unsaved (the draft loading) needs no copy.
		if (!mirror || !store || !key || (!keep && !opts.dirty())) return;
		const covers = edits.value;
		const copy = {
			v: 1 as const,
			savedAt: Date.now(),
			base: mirror.base(),
			data: mirror.snapshot(),
		};
		mirrorStamp = { key, savedAt: copy.savedAt };
		if ((await store.write(key, copy)) && (keep || covers === edits.value)) {
			mirroredEdits.value = covers;
		}
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
			await writeMirror(true);
			return;
		}
		const stamp = mirrorStamp;
		mirrorStamp = null;
		if (stamp) await store.removeIf(stamp.key, stamp.savedAt);
	};

	// ── Saving ──────────────────────────────────────────────────────────
	const run = (): Promise<void> => {
		if (running) return running;
		if (!canSave() || !opts.dirty()) return Promise.resolve();
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
			if (!error.value && canSave() && opts.dirty() && edits.value !== covers) schedule();
		})();
		return running;
	};

	watch(opts.changes, () => {
		if (!opts.enabled()) return;
		edits.value += 1;
		scheduleMirror();
		if (canSave()) schedule();
	});

	// Became savable with something unsaved (the draft finished loading, a
	// conflict was resolved, the backend came back): save it.
	watch(
		() => canSave() && opts.dirty() && online(),
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
		() => opts.enabled() && opts.dirty() && savedEdits.value !== edits.value && !onDevice.value
	);
	const status = computed<DraftSaveStatus>(() => {
		if (!opts.enabled()) return 'idle';
		if (opts.uncommitted?.()) return 'editing';
		if (error.value && !inFlight.value) return 'error';
		if (pending.value) return online() ? 'saving' : 'offline';
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
		// Text still open in an editor becomes part of the draft before the
		// page goes, so the save below includes it.
		onBeforeRouteLeave(() => {
			if (opts.enabled() && opts.uncommitted?.()) opts.commit?.();
		});
	}

	// Leaving the editor: what is still pending is saved now (the request
	// outlives the page within the app) and its device copy written.
	if (getCurrentScope())
		onScopeDispose(() => {
			if (opts.enabled() && (timerPending.value || mirrorTimer !== null || opts.dirty())) {
				if (mirrorTimer !== null) void writeMirror();
				clearSaveTimer();
				void run();
			}
			clearSaveTimer();
			clearMirrorTimer();
			disposed = true;
		});

	return {
		status,
		savedAt,
		error,
		onDevice,
		atRisk,
		flush,
		retry,
		cancel,
	};
}
