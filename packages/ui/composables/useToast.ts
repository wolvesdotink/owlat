import { generateId } from '@owlat/shared';
import { isReadingTimeToast, startToastReadingTime } from './useToastReadingTime';

/**
 * Toast notification composable
 * Provides a global toast notification system with success, error, info and
 * warning variants.
 */

/** The kind of toast — drives colour, icon and default lifetime. */
export type ToastType = 'success' | 'error' | 'info' | 'warning';

export interface ToastAction {
	label: string;
	onAction: () => void;
}

/**
 * What an observed action's work came to.
 *
 * - `true`: it happened. The toast goes.
 * - `false`: it did not, whatever the reason: a failure the caller has already
 *   reported (its own error toast stays the owner of the explanation), or a
 *   terminal answer such as "expired" or "already undone". The toast stays,
 *   marked as not done, and offers nothing to run again.
 * - `{ retryable: true }`: it failed and running it again is known to be safe.
 *   Only this puts the action back, and only while its deadline lasts.
 *
 * A rejected promise counts as `false`: an unknown outcome is never retried.
 */
export type ToastActionOutcome = boolean | { retryable: true };

/**
 * An inline action whose asynchronous outcome the toast waits for, instead of
 * vanishing the moment it is pressed. Opt-in: callers that pass a plain
 * {@link ToastAction} keep the fire-and-dismiss behaviour.
 */
export interface ToastObservedAction {
	label: string;
	/** The action's label while `run` is in flight, e.g. "Undoing…". */
	pendingLabel: string;
	/** Appended to the message when the outcome is not a success, e.g. "Not undone." */
	failedNote: string;
	run: () => Promise<ToastActionOutcome>;
}

export interface Toast {
	id: string;
	message: string;
	type: ToastType;
	action?: ToastAction;
	/**
	 * An observed action is running: the toast shows progress, ignores further
	 * presses and stays until the outcome is in.
	 */
	pending?: boolean;
}

export interface ToastOptions {
	/**
	 * How long the toast stays visible, in ms. Defaults to a per-type value
	 * (see {@link DEFAULT_DURATIONS_MS}). Pass `0` (or a non-positive/non-finite
	 * value) to make the toast sticky — it then stays until dismissed manually.
	 */
	durationMs?: number;
	/** Optional inline action button (e.g. "Undo"); clicking it dismisses the toast. */
	action?: ToastAction;
	/**
	 * An inline action whose outcome the toast observes (see
	 * {@link ToastObservedAction}). Takes the place of `action` when both are given.
	 */
	observedAction?: ToastObservedAction;
	/**
	 * Called exactly once when the toast leaves the screen — auto-dismiss, the
	 * close button, the action button, or {@link useToast.clearToasts}. For
	 * callers whose follow-up write means "the user has seen this" (marking a
	 * once-ever nudge acknowledged), which is not the same moment as "we put it
	 * on screen".
	 */
	onDismiss?: () => void;
}

/**
 * Default on-screen lifetime per toast type.
 *
 * Successes are transient — the result is already visible on screen. Errors
 * demand more reading time and a recovery decision, so they linger far longer
 * (and can be made sticky via `durationMs: 0`). Warnings sit in between; info
 * is treated like a quiet success.
 */
export const DEFAULT_DURATIONS_MS: Record<ToastType, number> = {
	success: 3000,
	info: 4000,
	warning: 6000,
	error: 8000,
};

// Global state for toasts (shared across all components)
const toasts = ref<Toast[]>([]);

// Dismiss callbacks, kept beside the reactive list rather than on the toast
// itself: the toast objects are rendered props, and a function on them would be
// reactive state nothing reads. Removing the entry as it fires is what makes
// the callback exactly-once.
const dismissHandlers = new Map<string, () => void>();

/**
 * Book-keeping for a toast with an observed action, beside the list for the
 * same reason. It lives as long as the toast does, so the card's action button
 * can never dismiss an observed toast, whatever state its action is in.
 */
interface ObservedEntry {
	action: ToastObservedAction;
	/** The toast's own lifetime in ms; non-positive means sticky. */
	durationMs: number;
	timer: ReturnType<typeof setTimeout> | undefined;
	/**
	 * When the action stops being offered, as a `performance.now()` instant
	 * fixed at show time (`Infinity` for a sticky toast). Checked before the
	 * action runs and before a retry brings it back, so neither depends on
	 * whether an overdue timer has fired yet. Monotonic on purpose: a wall-clock
	 * change must neither stretch nor cut the window. (The server's own expiry
	 * check stays the authority on whether the work itself may still happen.)
	 */
	actionDeadlineAt: number;
}

const observed = new Map<string, ObservedEntry>();

function isSticky(durationMs: number): boolean {
	return !(Number.isFinite(durationMs) && durationMs > 0);
}

function patchToast(id: string, patch: (toast: Toast) => Toast): void {
	const index = toasts.value.findIndex((t) => t.id === id);
	if (index > -1) toasts.value[index] = patch(toasts.value[index]!);
}

/**
 * Remove a specific toast by ID, running its `onDismiss` callback if it has
 * one. A second call for the same id is a no-op — the callback is gone with
 * the toast.
 */
function removeToast(id: string): void {
	const index = toasts.value.findIndex((t) => t.id === id);
	if (index > -1) {
		toasts.value.splice(index, 1);
	}
	const entry = observed.get(id);
	if (entry) {
		clearTimeout(entry.timer);
		observed.delete(id);
	}
	const onDismiss = dismissHandlers.get(id);
	if (onDismiss) {
		dismissHandlers.delete(id);
		onDismiss();
	}
}

/** The lifetime ran out. A running observed action holds its toast until it settles. */
function expireToast(id: string): void {
	if (observed.has(id) && toasts.value.find((t) => t.id === id)?.pending) return;
	removeToast(id);
}

/**
 * The action as the card renders it: its label, and a press that runs it. The
 * press hands back the run's promise; the card discards it like any other
 * `onAction` result.
 */
function renderedAction(id: string, label: string): ToastAction {
	return { label, onAction: () => runObservedAction(id) };
}

/**
 * Run an observed action once. A press while it runs is ignored, so the work
 * cannot start twice; a press after the deadline (its timer not yet run) only
 * lets the toast go. A rejection, or a synchronous throw, is re-thrown after
 * the toast is updated, so an unexpected error still surfaces the way a
 * discarded promise's would.
 */
async function runObservedAction(id: string): Promise<void> {
	const entry = observed.get(id);
	const toast = toasts.value.find((t) => t.id === id);
	if (!entry || !toast?.action || toast.pending) return;
	if (performance.now() >= entry.actionDeadlineAt) {
		removeToast(id);
		return;
	}
	patchToast(id, (t) => ({
		...t,
		pending: true,
		action: renderedAction(id, entry.action.pendingLabel),
	}));
	let outcome: ToastActionOutcome;
	try {
		outcome = await entry.action.run();
	} catch (error) {
		settleObservedAction(id, false);
		throw error;
	}
	settleObservedAction(id, outcome);
}

/** The note as a sentence of its own, after a message that may lack a full stop. */
function withNote(message: string, note: string): string {
	const trimmed = message.trimEnd();
	return /[.!?…]$/.test(trimmed) ? `${trimmed} ${note}` : `${trimmed}. ${note}`;
}

function settleObservedAction(id: string, outcome: ToastActionOutcome): void {
	const entry = observed.get(id);
	// Closed while it ran: the caller's own follow-up toast says how it went.
	if (!entry) return;
	if (outcome === true) {
		removeToast(id);
		return;
	}
	const now = performance.now();
	if (outcome !== false && outcome.retryable && now < entry.actionDeadlineAt) {
		// Back to idle until the original deadline, re-armed from the instant so
		// a timer that already fired while the work ran cannot leave it sticky.
		patchToast(id, (t) => ({
			...t,
			pending: false,
			action: renderedAction(id, entry.action.label),
		}));
		clearTimeout(entry.timer);
		if (Number.isFinite(entry.actionDeadlineAt)) {
			entry.timer = setTimeout(() => expireToast(id), entry.actionDeadlineAt - now);
		}
		return;
	}
	// Not done, and nothing to press again: the message stays true (the thing
	// the toast announced still stands), marked as not done, for a fresh
	// reading time as a warning.
	clearTimeout(entry.timer);
	entry.timer = undefined;
	const toast = toasts.value.find((t) => t.id === id);
	if (!toast) return;
	const type: ToastType = toast.type === 'error' ? 'error' : 'warning';
	patchToast(id, () => ({ id, message: withNote(toast.message, entry.action.failedNote), type }));
	if (!isSticky(entry.durationMs)) {
		entry.timer = setTimeout(() => removeToast(id), DEFAULT_DURATIONS_MS[type]);
	}
}

/**
 * The card's action button was pressed. A plain action is done with its toast.
 * An observed toast never goes on the press: its outcome, its deadline or the
 * close button decide, so even an action that settled synchronously (a throw
 * before its promise) keeps the card showing that outcome.
 */
function dismissAfterAction(id: string): void {
	if (observed.has(id)) return;
	removeToast(id);
}

export function useToast() {
	/**
	 * Show a toast notification
	 * @param message - The message to display
	 * @param type - The type of toast, defaults to 'success'
	 * @param options - Optional duration override and inline action button
	 * @returns the toast id (usable with removeToast for early dismissal)
	 */
	const showToast = (
		message: string,
		type: ToastType = 'success',
		options?: ToastOptions
	): string => {
		const id = generateId('toast');
		const observedAction = options?.observedAction;
		const action = observedAction ? renderedAction(id, observedAction.label) : options?.action;

		toasts.value.push({
			id,
			message,
			type,
			...(action ? { action } : {}),
		});

		if (options?.onDismiss) dismissHandlers.set(id, options.onDismiss);

		// An ordinary notification counts reading time instead: its budget pauses
		// while the card is hovered or focused and while the page is hidden or
		// unfocused (see useToastReadingTime). It takes over the lifetime, so the
		// one-shot timer below sees a sticky toast. A toast with an action keeps
		// that timer: pausing it would stretch the action's window.
		if (isReadingTimeToast(options)) {
			startToastReadingTime(
				id,
				options?.durationMs ?? DEFAULT_DURATIONS_MS[type],
				() => removeToast(id),
				() => toasts.value
			);
			options = { ...options, durationMs: 0 };
		}

		// Auto-dismiss after the resolved window. A non-positive or non-finite
		// duration means "sticky" — leave it up until dismissed manually.
		const durationMs = options?.durationMs ?? DEFAULT_DURATIONS_MS[type];
		const timer = isSticky(durationMs)
			? undefined
			: setTimeout(() => {
					expireToast(id);
				}, durationMs);
		if (observedAction) {
			observed.set(id, {
				action: observedAction,
				durationMs,
				timer,
				actionDeadlineAt: isSticky(durationMs)
					? Number.POSITIVE_INFINITY
					: performance.now() + durationMs,
			});
		}

		return id;
	};

	/**
	 * Clear all toasts. Each one is still a dismissal, so `onDismiss` fires —
	 * `removeToast` on an already-emptied list is just the callback.
	 */
	const clearToasts = () => {
		const ids = toasts.value.map((t) => t.id);
		toasts.value = [];
		for (const id of ids) removeToast(id);
	};

	return {
		toasts: readonly(toasts),
		showToast,
		removeToast,
		dismissAfterAction,
		clearToasts,
	};
}
