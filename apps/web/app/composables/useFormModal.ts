import type { Reactive, Ref, UnwrapRef } from 'vue';

/**
 * Form errors type with support for field-level and form-level errors.
 * The `general` key is reserved for form-level errors.
 */
export type FormErrors<T extends Record<string, unknown>> = {
	[K in keyof T]?: string;
} & {
	general?: string;
};

/**
 * Return type for useFormModal composable
 */
export interface UseFormModalReturn<T extends Record<string, unknown>> {
	/** Whether the modal is currently open */
	isOpen: Ref<boolean>;
	/** Whether the form is currently being submitted */
	isSubmitting: Ref<boolean>;
	/** Reactive form data */
	form: UnwrapRef<T>;
	/** Field-level and form-level errors (reactive object) */
	errors: Reactive<FormErrors<T>>;
	/** Opens the modal, resets form to initial state and clears errors */
	open: () => void;
	/** Closes the modal */
	close: () => void;
	/** Resets form to initial state and clears errors without closing */
	reset: () => void;
	/** Clears all error messages */
	clearErrors: () => void;
	/** Sets the form data (useful for edit modals) */
	setForm: (data: Partial<T>) => void;
}

/**
 * Composable for managing form modal state.
 * Provides standardized handling of open/close, form data, errors, and submission state.
 *
 * @example
 * const { isOpen, isSubmitting, form, errors, open, close } = useFormModal({
 *   name: '',
 *   email: '',
 * });
 *
 * // Open modal (resets form and errors)
 * open();
 *
 * // Submit handler
 * const handleSubmit = async () => {
 *   isSubmitting.value = true;
 *   try {
 *     await api.create(form);
 *     close();
 *   } catch (error) {
 *     errors.general = error.message;
 *   } finally {
 *     isSubmitting.value = false;
 *   }
 * };
 */
export function useFormModal<T extends Record<string, unknown>>(
	initialState: T
): UseFormModalReturn<T> {
	const isOpen = ref(false);
	const isSubmitting = ref(false);

	// Create reactive form with initial state
	const form = reactive({ ...initialState }) as UnwrapRef<T>;

	// Create reactive errors object with general key
	const errors = reactive<FormErrors<T>>({
		general: '',
	} as FormErrors<T>);

	/**
	 * Clears all error messages
	 */
	const clearErrors = () => {
		for (const key of Object.keys(errors)) {
			(errors as Record<string, string | undefined>)[key] = '';
		}
	};

	/**
	 * Resets form to initial state and clears errors
	 */
	const reset = () => {
		// Reset form to initial state
		for (const key of Object.keys(initialState)) {
			(form as Record<string, unknown>)[key] = initialState[key];
		}
		clearErrors();
	};

	/**
	 * Opens the modal, resets form to initial state and clears errors
	 */
	const open = () => {
		reset();
		isOpen.value = true;
	};

	/**
	 * Closes the modal
	 */
	const close = () => {
		isOpen.value = false;
	};

	/**
	 * Sets form data (useful for edit modals where you need to populate with existing data)
	 */
	const setForm = (data: Partial<T>) => {
		for (const key of Object.keys(data)) {
			if (key in form) {
				(form as Record<string, unknown>)[key] = data[key];
			}
		}
	};

	return {
		isOpen,
		isSubmitting,
		form,
		errors,
		open,
		close,
		reset,
		clearErrors,
		setForm,
	};
}
