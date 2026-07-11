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
	 * Remove a specific toast by ID
	 */
	const removeToast = (id: string) => {
		const index = toasts.value.findIndex((t) => t.id === id);
		if (index > -1) {
			toasts.value.splice(index, 1);
		}
	};

	/**
	 * Clear all toasts
	 */
	const clearToasts = () => {
		toasts.value = [];
	};

	return {
		toasts: readonly(toasts),
		showToast,
		removeToast,
		clearToasts,
	};
}
