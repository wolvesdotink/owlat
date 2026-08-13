import { generateId } from '@owlat/shared';

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

export interface Toast {
	id: string;
	message: string;
	type: ToastType;
	action?: ToastAction;
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

		toasts.value.push({
			id,
			message,
			type,
			...(options?.action ? { action: options.action } : {}),
		});

		if (options?.onDismiss) dismissHandlers.set(id, options.onDismiss);

		// Auto-dismiss after the resolved window. A non-positive or non-finite
		// duration means "sticky" — leave it up until dismissed manually.
		const durationMs = options?.durationMs ?? DEFAULT_DURATIONS_MS[type];
		if (Number.isFinite(durationMs) && durationMs > 0) {
			setTimeout(() => {
				removeToast(id);
			}, durationMs);
		}

		return id;
	};

	/**
	 * Remove a specific toast by ID, running its `onDismiss` callback if it has
	 * one. A second call for the same id is a no-op — the callback is gone with
	 * the toast.
	 */
	const removeToast = (id: string) => {
		const index = toasts.value.findIndex((t) => t.id === id);
		if (index > -1) {
			toasts.value.splice(index, 1);
		}
		const onDismiss = dismissHandlers.get(id);
		if (onDismiss) {
			dismissHandlers.delete(id);
			onDismiss();
		}
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
		clearToasts,
	};
}
