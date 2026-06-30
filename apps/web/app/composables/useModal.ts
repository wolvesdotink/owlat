/**
 * Modal management composable
 * Provides reusable state and methods for modal dialogs
 */

export function useModal<T = unknown>(options?: { onOpen?: () => void; onClose?: () => void }) {
	const isOpen = ref(false);
	const isLoading = ref(false);
	const error = ref<string | null>(null);
	const data = ref<T | null>(null) as Ref<T | null>;

	const open = (initialData?: T) => {
		if (initialData !== undefined) {
			data.value = initialData;
		}
		error.value = null;
		isOpen.value = true;
		options?.onOpen?.();
	};

	const close = () => {
		isOpen.value = false;
		isLoading.value = false;
		error.value = null;
		options?.onClose?.();
	};

	const reset = () => {
		data.value = null;
		error.value = null;
		isLoading.value = false;
	};

	const setError = (message: string) => {
		error.value = message;
	};

	const clearError = () => {
		error.value = null;
	};

	const setLoading = (loading: boolean) => {
		isLoading.value = loading;
	};

	/**
	 * Execute an async action with automatic loading and error handling
	 */
	const execute = async <R>(
		action: () => Promise<R>,
		options?: {
			closeOnSuccess?: boolean;
			onSuccess?: (result: R) => void;
			onError?: (error: Error) => void;
		}
	): Promise<R | undefined> => {
		isLoading.value = true;
		error.value = null;

		try {
			const result = await action();
			if (options?.closeOnSuccess !== false) {
				close();
			}
			options?.onSuccess?.(result);
			return result;
		} catch (e) {
			const errorMessage = e instanceof Error ? e.message : 'An error occurred';
			error.value = errorMessage;
			options?.onError?.(e instanceof Error ? e : new Error(errorMessage));
			return undefined;
		} finally {
			isLoading.value = false;
		}
	};

	return {
		isOpen: readonly(isOpen),
		isLoading: readonly(isLoading),
		error: readonly(error),
		data,
		open,
		close,
		reset,
		setError,
		clearError,
		setLoading,
		execute,
	};
}

/**
 * Specialized modal for delete/confirm operations
 */
export function useConfirmModal<T = unknown>() {
	const modal = useModal<T>();

	const confirm = async (
		action: () => Promise<void>,
		options?: { onSuccess?: () => void; onError?: (error: Error) => void }
	) => {
		return modal.execute(action, {
			closeOnSuccess: true,
			onSuccess: options?.onSuccess,
			onError: options?.onError,
		});
	};

	return {
		...modal,
		confirm,
	};
}
