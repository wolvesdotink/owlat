import { generateId } from '@owlat/shared';

/**
 * Toast notification composable
 * Provides a global toast notification system with success and error variants
 */

export interface ToastAction {
	label: string;
	onAction: () => void;
}

export interface Toast {
	id: string;
	message: string;
	type: 'success' | 'error';
	action?: ToastAction;
}

export interface ToastOptions {
	/** How long the toast stays visible. Defaults to 3000ms. */
	durationMs?: number;
	/** Optional inline action button (e.g. "Undo"); clicking it dismisses the toast. */
	action?: ToastAction;
}

// Global state for toasts (shared across all components)
const toasts = ref<Toast[]>([]);

export function useToast() {
	/**
	 * Show a toast notification
	 * @param message - The message to display
	 * @param type - The type of toast ('success' | 'error'), defaults to 'success'
	 * @param options - Optional duration override and inline action button
	 * @returns the toast id (usable with removeToast for early dismissal)
	 */
	const showToast = (
		message: string,
		type: 'success' | 'error' = 'success',
		options?: ToastOptions
	): string => {
		const id = generateId('toast');

		toasts.value.push({
			id,
			message,
			type,
			...(options?.action ? { action: options.action } : {}),
		});

		// Auto-dismiss after the requested window (3 seconds by default)
		setTimeout(() => {
			removeToast(id);
		}, options?.durationMs ?? 3000);

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
