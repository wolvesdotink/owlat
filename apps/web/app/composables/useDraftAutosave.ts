import {
	computed,
	getCurrentScope,
	nextTick,
	onScopeDispose,
	shallowRef,
	watch,
	type ComputedRef,
	type ShallowRef,
} from 'vue';
import { backendConnectionPhase } from '~/lib/backendConnection';
import { StaleDraftError } from './useEditorSaveOperation';
import {
	createDraftSession,
	transition,
	type DraftEffect,
	type DraftEvent,
	type DraftFlight,
	type DraftLeaveRefusal,
	type DraftReceipt,
	type DraftSessionState,
	type Fingerprints,
} from '~/utils/draftSession';
import {
	atRisk,
	holdsSends,
	isDirty,
	onDevice,
	saveStatus,
	sendableFields,
	type DraftSaveStatus,
} from '~/utils/draftSessionSelectors';
import {
	editorDraftKey,
	getEditorDraftStore,
	type EditorDraftStore,
} from '~/utils/editorDraftStore';
import { getEditorDraftWriters, type EditorDraftWriters } from '~/utils/editorDraftWriters';
import { useDraftLeave, type DraftLeaveDecisions } from './useDraftLeave';
import { readDraftCandidates, useDraftRecovery, type DraftRecovery } from './useDraftRecovery';

/**
 * Draft autosave: runs a draft editor's session (`utils/draftSession.ts`) for
 * the draft editors (email template, campaign). The session decides; this
 * runs what it decides (the debounce and mirror timers, the save, the device
 * copy, reading copies left behind, the leave prompt's steps) and reports each
 * outcome back to it, and exposes what it derives (`status`, `atRisk`, ...).
 *
 * - An edit restarts a short pause; then the draft is saved. One save runs at
 *   a time; an edit made meanwhile is saved after it.
 * - An edit is also written to this editor's device copy a moment later, and
 *   the copy goes once the server holds everything in it.
 * - A copy another editor left behind is only ever offered (`recovery`);
 *   Restore makes it an edit of this draft, never a silent replacement.
 * - `leave` decides a leave: open text is committed and the device copy given
 *   a bounded moment first; the prompt shows only while something would be
 *   lost; its Save goes through the same queue; Discard drops what was not
 *   sent. A newer leave request, Stay or closing retires a decision.
 * - `flush` saves now (Publish, the Save shortcut); `runAction` holds the
 *   background saves while a final action (Send, Schedule, Publish) runs.
 *
 * Failures show in the status, not as a toast per attempt; the next edit,
 * `retry` or the backend coming back tries again. While the backend is
 * unreachable the Convex client holds the mutation and sends it on reconnect.
 */

export interface DraftAutosaveOptions<T> {
	/** Autosave applies to what is open (a loaded draft). */
	enabled: () => boolean;
	/** Where this draft's device copies live (`editorDraftScope`); null while unknown. */
	scope: () => string | null;
	/**
	 * The editor's fields as fingerprints, read synchronously. Without it the
	 * editor reports its edits itself (live co-editing).
	 */
	read?: () => { values: Fingerprints; deviceOnly?: readonly string[] };
	/** The device copy's data, read synchronously. */
	snapshot: () => T;
	/**
	 * Persist `flight`. Read the editor synchronously before the first
	 * `await`; reject when it did not land (a `StaleDraftError` opens the
	 * conflict).
	 */
	persist: (flight: DraftFlight) => Promise<DraftReceipt>;
	/** Text is being typed that the fields do not hold yet. */
	inline?: () => boolean;
	/** Make that text part of the fields (close the text editor). */
	commitInline?: () => void;
	/** Shape check for a stored copy's data (it may come from an older build). */
	accept: (data: unknown) => data is T;
	/** A copy's data says what the editor shows now. */
	matches: (data: T) => boolean;
	/** Put a restored copy's data into the editor (an edit like any other). */
	apply: (data: T) => void;
	/** Follow the latest server row (the session found the draft clean). */
	hydrate?: () => void;
	/** Replace the draft with the server's state ("Load latest"). */
	reload?: () => void;
	/** Live co-editing: hand over or drop what this tab has not sent. */
	live?: { sendUnsent: () => void; dropUnsent: () => void };
	/** Recovery may look for copies: the editor shows the server's state. */
	ready?: () => boolean;
	/** A Save in the leave prompt did not let the page go. */
	onRefused?: (reason: DraftLeaveRefusal) => void;
	/** Fields no draft save or device copy holds (they wait for an action). */
	volatile?: readonly string[];
	/** How long the editor waits after the last edit; default 1500 ms. */
	debounceMs?: number;
	/** Whether the backend is reachable; default: the app's connection state. */
	online?: () => boolean;
	/** Injected in tests; defaults to the page's IndexedDB store. */
	store?: EditorDraftStore;
	/** Injected in tests; defaults to the page's writers. */
	writers?: EditorDraftWriters;
}

export interface DraftAutosave<T = unknown> {
	state: Readonly<ShallowRef<DraftSessionState>>;
	status: ComputedRef<DraftSaveStatus>;
	/** When the last save landed. */
	savedAt: ComputedRef<number | null>;
	/** The last save's failure, until a save lands. */
	error: ComputedRef<unknown>;
	/** Everything the draft holds is on this device. */
	onDevice: ComputedRef<boolean>;
	/** The draft holds something the server does not. */
	dirty: ComputedRef<boolean>;
	/** Leaving now would lose something. */
	atRisk: ComputedRef<boolean>;
	/** New collaboration sends wait (a leave is being decided). */
	holdsSends: ComputedRef<boolean>;
	dispatch: (event: DraftEvent) => void;
	/** Report fields that changed (an edit, when the editor reports its own). */
	edit: (values: Fingerprints, deviceOnly?: readonly string[]) => void;
	/** Save now; resolves true when nothing is left to save. */
	flush: () => Promise<boolean>;
	retry: () => void;
	/** Discard: nothing of the current edits is saved or kept; the next edit saves again. */
	discard: () => void;
	/**
	 * Hold background saves while `perform` (a final action) runs. On success
	 * the `consumes` fields count as done with the values they had at the start.
	 */
	runAction: (perform: () => Promise<boolean>, consumes?: readonly string[]) => Promise<boolean>;
	leave: DraftLeaveDecisions;
	recovery: DraftRecovery<T>;
}

/** Saves a flush starts before giving up on an editor that keeps changing. */
const FLUSH_ROUNDS = 3;

const defaultOnline = () =>
	backendConnectionPhase.value === null &&
	(typeof navigator === 'undefined' || navigator.onLine !== false);

export function useDraftAutosave<T>(opts: DraftAutosaveOptions<T>): DraftAutosave<T> {
	const store = opts.store ?? getEditorDraftStore();
	const writer = (opts.writers ?? getEditorDraftWriters()).open();
	const writers = opts.writers ?? getEditorDraftWriters();
	const state = shallowRef(
		createDraftSession({
			writer: writer.id,
			volatile: opts.volatile,
			debounceMs: opts.debounceMs,
		})
	);

	const timers = new Map<string, ReturnType<typeof setTimeout>>();
	const flights = new Map<number, Promise<void>>();
	const candidateData = new Map<string, T>();
	let actions = 0;

	// ── Dispatching ──────────────────────────────────────────────────────
	const queue: DraftEvent[] = [];
	let dispatching = false;
	const dispatch = (event: DraftEvent) => {
		queue.push(event);
		if (dispatching) return;
		dispatching = true;
		try {
			while (queue.length > 0) {
				const step = transition(state.value, queue.shift()!);
				state.value = step.state;
				for (const effect of step.effects) execute(effect);
			}
		} finally {
			dispatching = false;
		}
	};

	/** Report what the editor holds right now, before a decision reads the session. */
	const sync = () => {
		const s = state.value;
		if (s.closed) return;
		if (opts.read && s.base && !s.live) {
			const reading = opts.read();
			dispatch({ type: 'edit', values: reading.values, deviceOnly: reading.deviceOnly ?? [] });
		}
		const open = opts.inline?.() === true;
		if (open !== state.value.inline) dispatch({ type: 'inline', open });
	};

	const ownKey = () => {
		const scope = opts.scope();
		return scope ? editorDraftKey(scope, writer.id) : null;
	};

	// ── Effects ──────────────────────────────────────────────────────────
	function execute(effect: DraftEffect) {
		switch (effect.type) {
			case 'timer': {
				const previous = timers.get(effect.name);
				if (previous !== undefined) clearTimeout(previous);
				timers.set(
					effect.name,
					setTimeout(() => {
						timers.delete(effect.name);
						sync();
						dispatch({ type: 'timer', name: effect.name, id: effect.id });
					}, effect.ms)
				);
				break;
			}
			case 'persist': {
				const { flight } = effect;
				let outcome: Promise<DraftReceipt>;
				try {
					outcome = opts.persist(flight);
				} catch (error) {
					outcome = Promise.reject(error);
				}
				flights.set(
					flight.id,
					outcome.then(
						(receipt) => dispatch({ type: 'saved', flight: flight.id, receipt, at: Date.now() }),
						(error: unknown) =>
							dispatch({
								type: 'save-failed',
								flight: flight.id,
								error,
								conflict: error instanceof StaleDraftError ? error.currentRevision : null,
							})
					)
				);
				void flights.get(flight.id)!.then(() => flights.delete(flight.id));
				break;
			}
			case 'write-copy': {
				const { write } = effect;
				const key = ownKey();
				if (!key) {
					queue.push({ type: 'copy-failed', token: write.token });
					break;
				}
				const copy = {
					v: 2 as const,
					token: write.token,
					seq: write.seq,
					savedAt: Date.now(),
					base: write.base,
					data: opts.snapshot(),
				};
				void store
					.write(key, copy)
					.then((written) =>
						dispatch({ type: written ? 'copy-committed' : 'copy-failed', token: write.token })
					);
				break;
			}
			case 'remove-copies': {
				const key = effect.key ?? ownKey();
				if (key) void store.removeIf(key, effect.tokens);
				break;
			}
			case 'read-copies': {
				const { request, scope } = effect;
				const reader = {
					store,
					writers,
					own: writer.id,
					accept: opts.accept,
					matches: opts.matches,
				};
				void readDraftCandidates(reader, scope, (token, data) =>
					candidateData.set(token, data)
				).then(
					(candidates) => {
						sync();
						dispatch({ type: 'recovery-read', request, candidates });
					},
					() => dispatch({ type: 'recovery-read', request, candidates: [] })
				);
				break;
			}
			case 'apply-copy': {
				const data = candidateData.get(effect.candidate.token);
				if (data === undefined) break;
				opts.apply(data);
				sync();
				dispatch({ type: 'recovery-applied', request: effect.request });
				break;
			}
			case 'hydrate':
				opts.hydrate?.();
				break;
			case 'reload':
				opts.reload?.();
				break;
			case 'prepare-leave': {
				const ready = () => {
					sync();
					dispatch({ type: 'leave-ready', id: effect.id });
				};
				if (opts.inline?.() && opts.commitInline) {
					opts.commitInline();
					// The committed text reaches the fields through the editor's watchers.
					void nextTick(ready);
				} else {
					ready();
				}
				break;
			}
			case 'verdict':
				decisions.answer(effect.id, effect.leave);
				break;
			case 'flush-leave':
				queueMicrotask(
					() => void flush().then((ok) => dispatch({ type: 'leave-saved', id: effect.id, ok }))
				);
				break;
			case 'settled':
				if (effect.reason) opts.onRefused?.(effect.reason);
				decisions.settle(effect.id, effect.destination);
				break;
			case 'drop-unsent':
				opts.live?.dropUnsent();
				break;
			case 'send-unsent':
				opts.live?.sendUnsent();
				break;
		}
	}

	// ── Inputs ───────────────────────────────────────────────────────────
	dispatch({ type: 'storage', persistent: store.persistent });
	const online = opts.online ?? defaultOnline;
	watch(online, (value) => dispatch({ type: 'online', online: value }), { immediate: true });
	watch(opts.enabled, (value) => dispatch({ type: 'enabled', enabled: value }), {
		immediate: true,
	});
	if (opts.inline) watch(opts.inline, () => sync());
	watch(
		() =>
			state.value.enabled && state.value.base !== null && opts.ready?.() !== false
				? opts.scope()
				: null,
		(scope) => {
			if (scope) dispatch({ type: 'recovery-start', scope });
		},
		{ immediate: true }
	);

	// ── Commands ─────────────────────────────────────────────────────────
	const flush = async (): Promise<boolean> => {
		if (opts.inline?.() && opts.commitInline) {
			opts.commitInline();
			await nextTick();
		}
		sync();
		let started = 0;
		for (;;) {
			const running = state.value.flight;
			if (running) {
				await flights.get(running.id);
				continue;
			}
			if (started >= FLUSH_ROUNDS) break;
			dispatch({ type: 'save-now' });
			const flight = state.value.flight;
			if (!flight) break;
			started += 1;
			await flights.get(flight.id);
			if (state.value.failure !== null) return false;
			sync();
		}
		const s = state.value;
		return s.failure === null && s.conflict === null && !s.inline && sendableFields(s).length === 0;
	};

	const runAction = async (perform: () => Promise<boolean>, consumes: readonly string[] = []) => {
		actions += 1;
		const id = actions;
		sync();
		dispatch({ type: 'action-begin', id });
		let ok = false;
		try {
			ok = await perform();
		} finally {
			dispatch({ type: 'action-end', id, ok, consumed: consumes });
		}
		return ok;
	};

	const isAtRisk = () => {
		sync();
		return atRisk(state.value);
	};
	const decisions = useDraftLeave(state, dispatch, sync, isAtRisk);

	const recovery = useDraftRecovery<T>(state, dispatch, (token) => candidateData.get(token), sync);

	// Closing: what was not discarded gets one last save and copy (best
	// effort), every decision still open settles, and the editor's lock goes.
	if (getCurrentScope()) {
		onScopeDispose(() => {
			sync();
			dispatch({ type: 'close' });
			for (const timer of timers.values()) clearTimeout(timer);
			timers.clear();
			writer.close();
		});
	}

	return {
		state,
		status: computed(() => saveStatus(state.value)),
		savedAt: computed(() => state.value.savedAt),
		error: computed(() => state.value.failure),
		onDevice: computed(() => onDevice(state.value)),
		dirty: computed(() => isDirty(state.value)),
		atRisk: computed(() => atRisk(state.value)),
		holdsSends: computed(() => holdsSends(state.value)),
		dispatch,
		edit: (values, deviceOnly) => dispatch({ type: 'edit', values, deviceOnly }),
		flush,
		retry: () => dispatch({ type: 'retry' }),
		discard: () => dispatch({ type: 'discard' }),
		runAction,
		leave: decisions.leave,
		recovery,
	};
}
