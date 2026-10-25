import {
	computed,
	getCurrentScope,
	nextTick,
	onScopeDispose,
	ref,
	shallowRef,
	watch,
	type ComputedRef,
	type Ref,
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
	type DraftLive,
	type DraftReceipt,
	type DraftSessionState,
	type Fingerprints,
} from '~/utils/draftSession';
import {
	actionCurrent,
	atRisk,
	holdsSends,
	isDirty,
	saveStatus,
	serverHolds,
	type DraftSaveStatus,
} from '~/utils/draftSessionSelectors';
import { useDraftLeave, type DraftLeaveDecisions } from './useDraftLeave';

/**
 * Draft autosave: runs a draft email template editor's session
 * (`utils/draftSession.ts`). The session decides; this runs what it decides
 * (the debounce timer, the save, the leave prompt's steps) and reports each
 * outcome back to it, and exposes what it derives (`status`, `atRisk`, ...).
 *
 * - An edit restarts a short pause; then the draft is saved. One save runs at
 *   a time; an edit made meanwhile is saved after it.
 * - Nothing is kept on the device: an edit is at risk until the server
 *   acknowledged it, and leaving (or closing the tab) asks until then.
 * - `leave` decides a leave: open text is committed first; the prompt shows
 *   only while the server does not hold what the editor shows; its Save goes
 *   through the same queue; Discard drops what was not sent. A newer leave
 *   request, Stay or closing retires a decision.
 * - `flush` saves now (Publish, Save, the leave prompt) and is done only
 *   once the server holds what the editor shows; `runAction` holds the
 *   background saves while a final action (Publish) runs.
 *
 * Failures show in the status, not as a toast per attempt; the next edit,
 * `retry` or the backend coming back tries again. While the backend is
 * unreachable the Convex client holds the mutation and sends it on reconnect.
 */

export interface DraftAutosaveOptions {
	/** Autosave applies to what is open (a loaded draft). */
	enabled: () => boolean;
	/**
	 * The editor's fields as fingerprints, read synchronously. Without it the
	 * editor reports its edits itself (live co-editing).
	 */
	read?: () => Fingerprints;
	/** Live co-editing: what the session reports now, read synchronously (null: not live). */
	readLive?: () => DraftLive | null;
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
	/** Follow the latest server row (the session found the draft clean). */
	hydrate?: () => void;
	/** Replace the draft with the server's state ("Load latest"). */
	reload?: () => void;
	/** Live co-editing: drop what this tab has not sent (Discard). */
	dropUnsent?: () => void;
	/** A Save in the leave prompt did not let the page go. */
	onRefused?: () => void;
	/** How long the editor waits after the last edit; default 1500 ms. */
	debounceMs?: number;
	/** Whether the backend is reachable; default: the app's connection state and the browser's. */
	online?: () => boolean;
	/** Sees each event once the session took it and its effects started (tests). */
	observe?: (event: DraftEvent) => void;
}

export interface DraftAutosave {
	state: Readonly<ShallowRef<DraftSessionState>>;
	status: ComputedRef<DraftSaveStatus>;
	/** When the last save landed. */
	savedAt: ComputedRef<number | null>;
	/** The last save's failure, until a save lands. */
	error: ComputedRef<unknown>;
	/** The draft holds an edit of this editor the server does not. */
	dirty: ComputedRef<boolean>;
	/** Leaving now would lose something. */
	atRisk: ComputedRef<boolean>;
	/** New collaboration sends wait (a leave is being decided). */
	holdsSends: ComputedRef<boolean>;
	dispatch: (event: DraftEvent) => void;
	/** Report fields that changed (an edit, when the editor reports its own). */
	edit: (values: Fingerprints) => void;
	/** Save now; resolves true once the server holds what the editor shows. */
	flush: () => Promise<boolean>;
	retry: () => void;
	/** Discard: nothing of the current edits is saved; the next edit saves again. */
	discard: () => void;
	/**
	 * Hold background saves while `perform` (a final action) runs. `perform`
	 * asks `current()` right before its final dispatch: false when the editor
	 * no longer shows what the server holds (an edit made while the action
	 * saved, someone else's edit the email does not hold), and then it must
	 * not dispatch.
	 */
	runAction: (perform: (current: () => boolean) => Promise<boolean>) => Promise<boolean>;
	leave: DraftLeaveDecisions;
}

/** Saves a flush starts before giving up on an editor that keeps changing. */
const FLUSH_ROUNDS = 3;

/** The browser's connectivity, followed through its events while the editor is open. */
function browserOnline(): Ref<boolean> {
	const read = () => typeof navigator === 'undefined' || navigator.onLine !== false;
	const online = ref(read());
	if (typeof window === 'undefined' || !getCurrentScope()) return online;
	const update = () => {
		online.value = read();
	};
	window.addEventListener('online', update);
	window.addEventListener('offline', update);
	onScopeDispose(() => {
		window.removeEventListener('online', update);
		window.removeEventListener('offline', update);
	});
	return online;
}

const sameLive = (a: DraftLive | null, b: DraftLive | null) =>
	a === b ||
	(a !== null &&
		b !== null &&
		a.sessionId === b.sessionId &&
		a.base === b.base &&
		a.sharedPending === b.sharedPending &&
		a.unsent === b.unsent &&
		a.alone === b.alone);

export function useDraftAutosave(opts: DraftAutosaveOptions): DraftAutosave {
	const state = shallowRef(createDraftSession({ debounceMs: opts.debounceMs }));

	let timer: ReturnType<typeof setTimeout> | null = null;
	const flights = new Map<number, Promise<void>>();
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
				const event = queue.shift()!;
				const step = transition(state.value, event);
				state.value = step.state;
				for (const effect of step.effects) execute(effect);
				opts.observe?.(event);
			}
		} finally {
			dispatching = false;
		}
	};

	/** Report what the editor holds right now, before a decision reads the session. */
	const sync = () => {
		const s = state.value;
		if (s.closed) return;
		if (opts.readLive) {
			const live = opts.readLive();
			if (!sameLive(live, state.value.live)) dispatch({ type: 'live', live });
		}
		if (opts.read && state.value.base && !state.value.live) {
			dispatch({ type: 'edit', values: opts.read() });
		}
		const open = opts.inline?.() === true;
		if (open !== state.value.inline) dispatch({ type: 'inline', open });
	};

	// ── Effects ──────────────────────────────────────────────────────────
	function execute(effect: DraftEffect) {
		switch (effect.type) {
			case 'timer': {
				if (timer !== null) clearTimeout(timer);
				timer = setTimeout(() => {
					timer = null;
					sync();
					dispatch({ type: 'timer', id: effect.id });
				}, effect.ms);
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
				if (effect.refused) opts.onRefused?.();
				decisions.settle(effect.id, effect.destination);
				break;
			case 'drop-unsent':
				opts.dropUnsent?.();
				break;
		}
	}

	// ── Inputs ───────────────────────────────────────────────────────────
	const browser = opts.online ? null : browserOnline();
	const online = opts.online ?? (() => backendConnectionPhase.value === null && browser!.value);
	watch(online, (value) => dispatch({ type: 'online', online: value }), { immediate: true });
	watch(opts.enabled, (value) => dispatch({ type: 'enabled', enabled: value }), {
		immediate: true,
	});
	if (opts.inline) watch(opts.inline, () => sync());

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
				sync();
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
		return s.failure === null && s.conflict === null && serverHolds(s);
	};

	const runAction: DraftAutosave['runAction'] = async (perform) => {
		actions += 1;
		const id = actions;
		sync();
		dispatch({ type: 'action-begin', id });
		const current = () => {
			sync();
			return actionCurrent(state.value, id);
		};
		try {
			return await perform(current);
		} finally {
			dispatch({ type: 'action-end', id });
		}
	};

	const isAtRisk = () => {
		sync();
		return atRisk(state.value);
	};
	const decisions = useDraftLeave(state, dispatch, sync, isAtRisk);

	// Closing settles every decision still open and stops the timer; it saves nothing.
	if (getCurrentScope()) {
		onScopeDispose(() => {
			dispatch({ type: 'close' });
			if (timer !== null) clearTimeout(timer);
			timer = null;
		});
	}

	return {
		state,
		status: computed(() => saveStatus(state.value)),
		savedAt: computed(() => state.value.savedAt),
		error: computed(() => state.value.failure),
		dirty: computed(() => isDirty(state.value)),
		atRisk: computed(() => atRisk(state.value)),
		holdsSends: computed(() => holdsSends(state.value)),
		dispatch,
		edit: (values) => dispatch({ type: 'edit', values }),
		flush,
		retry: () => dispatch({ type: 'retry' }),
		discard: () => dispatch({ type: 'discard' }),
		runAction,
		leave: decisions.leave,
	};
}
