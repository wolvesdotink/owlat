import { generateId } from '@owlat/shared';

/**
 * Toast notification composable
 * Provides a global toast notification system with success and error variants
 */

export interface Toast {
	id: string;
	message: string;
	type: 'success' | 'error';
}

// Global state for toasts (shared across all components)
const toasts = ref<Toast[]>([]);

export function useToast() {
	/**
	 * Show a toast notification
	 * @param message - The message to display
	 * @param type - The type of toast ('success' | 'error'), defaults to 'success'
	 */
	const showToast = (message: string, type: 'success' | 'error' = 'success') => {
		const id = generateId('toast');

		toasts.value.push({
			id,
			message,
			type,
		});

		// Auto-dismiss after 3 seconds
		setTimeout(() => {
			removeToast(id);
		}, 3000);
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
