/**
 * Form validation composable
 * Provides reusable form validation with field-level error handling
 */
import { emailRegex, domainRegex, isValidUrl } from '@owlat/shared';

export type ValidationRule<T = string> = (value: T) => string | true;

export interface ValidationSchema {
	[field: string]: ValidationRule | ValidationRule[];
}

export function useFormValidation<T extends Record<string, unknown>>(schema?: ValidationSchema) {
	const errors = ref<Record<string, string>>({});
	const touched = ref<Set<string>>(new Set());

	// Optional reactive form data reference for single-arg validateField calls
	let boundFormData: (() => Record<string, unknown>) | null = null;

	/**
	 * Validate a single field.
	 *
	 * Can be called two ways:
	 * - validateField('email', someValue) — validates with the given value
	 * - validateField('email') — validates using bound form data (requires bindFormData)
	 *
	 * The single-arg form enables blur handlers: @blur="validateField('email')"
	 */
	const validateField = (field: string, value?: unknown): boolean => {
		if (!schema?.[field]) return true;

		// If value not provided, look it up from bound form data
		const resolvedValue = value !== undefined ? value : boundFormData?.()[field];

		const rules = Array.isArray(schema[field]) ? schema[field] : [schema[field]];

		for (const rule of rules) {
			const result = (rule as ValidationRule)(resolvedValue as string);
			if (result !== true) {
				errors.value[field] = result;
				return false;
			}
		}

		delete errors.value[field];
		return true;
	};

	/**
	 * Validate all fields in the form data
	 */
	const validate = (data: T): boolean => {
		errors.value = {};

		if (!schema) return true;

		let isValid = true;

		for (const field of Object.keys(schema)) {
			const value = data[field];
			if (!validateField(field, value)) {
				isValid = false;
			}
		}

		return isValid;
	};

	/**
	 * Mark a field as touched (for showing errors only after interaction)
	 */
	const touch = (field: string) => {
		touched.value.add(field);
	};

	/**
	 * Check if a field has been touched
	 */
	const isTouched = (field: string): boolean => {
		return touched.value.has(field);
	};

	/**
	 * Get error for a field (only if touched, unless showAll is true)
	 */
	const getError = (field: string, showAll = false): string | undefined => {
		if (!showAll && !isTouched(field)) return undefined;
		return errors.value[field];
	};

	/**
	 * Set a custom error for a field
	 */
	const setError = (field: string, message: string) => {
		errors.value[field] = message;
	};

	/**
	 * Clear error for a specific field
	 */
	const clearError = (field: string) => {
		delete errors.value[field];
	};

	/**
	 * Clear all errors
	 */
	const clearErrors = () => {
		errors.value = {};
	};

	/**
	 * Reset validation state
	 */
	const reset = () => {
		errors.value = {};
		touched.value = new Set();
	};

	/**
	 * Check if form has any errors
	 */
	const hasErrors = computed(() => Object.keys(errors.value).length > 0);

	/**
	 * Check if a field has an error
	 */
	const hasError = (field: string): boolean => {
		return field in errors.value;
	};

	/**
	 * Alias for clearError — clears a single field's error.
	 * Useful as an @input handler to clear errors as the user types.
	 *
	 * Example: @input="clearFieldError('email')"
	 */
	const clearFieldError = (field: string) => {
		delete errors.value[field];
	};

	/**
	 * Bind reactive form data so validateField can be called with just the field name.
	 * The getter is called lazily each time validation runs, so it always reads current values.
	 *
	 * Example:
	 *   const form = reactive({ email: '', name: '' });
	 *   const { validateField, bindFormData } = useFormValidation(schema);
	 *   bindFormData(() => form);
	 *   // Now you can use: @blur="validateField('email')"
	 */
	const bindFormData = (getter: () => Record<string, unknown>) => {
		boundFormData = getter;
	};

	/**
	 * Convenience handler for blur events: marks field as touched and validates it.
	 * Requires bindFormData to have been called, or pass value as second argument.
	 *
	 * Example: @blur="handleBlur('email')"
	 */
	const handleBlur = (field: string, value?: unknown) => {
		touch(field);
		validateField(field, value);
	};

	/**
	 * Convenience handler for input events: clears the field error while the user types.
	 *
	 * Example: @input="handleInput('email')"
	 */
	const handleInput = (field: string) => {
		clearFieldError(field);
	};

	return {
		errors: readonly(errors),
		touched: readonly(touched),
		hasErrors,
		validate,
		validateField,
		touch,
		isTouched,
		getError,
		setError,
		clearError,
		clearErrors,
		clearFieldError,
		reset,
		hasError,
		bindFormData,
		handleBlur,
		handleInput,
	};
}

/**
 * Common validation rules
 */
export const rules = {
	required: (message = 'This field is required'): ValidationRule => {
		return (value) => {
			if (
				value === null ||
				value === undefined ||
				value === '' ||
				(Array.isArray(value) && value.length === 0)
			) {
				return message;
			}
			return true;
		};
	},

	email: (message = 'Please enter a valid email address'): ValidationRule => {
		return (value) => {
			if (!value) return true;
			return emailRegex.test(String(value)) || message;
		};
	},

	minLength: (min: number, message?: string): ValidationRule => {
		return (value) => {
			if (!value) return true;
			const actualMessage = message || `Must be at least ${min} characters`;
			return String(value).length >= min || actualMessage;
		};
	},

	maxLength: (max: number, message?: string): ValidationRule => {
		return (value) => {
			if (!value) return true;
			const actualMessage = message || `Must be no more than ${max} characters`;
			return String(value).length <= max || actualMessage;
		};
	},

	pattern: (regex: RegExp, message = 'Invalid format'): ValidationRule => {
		return (value) => {
			if (!value) return true;
			return regex.test(String(value)) || message;
		};
	},

	domain: (message = 'Please enter a valid domain name'): ValidationRule => {
		return (value) => {
			if (!value) return true;
			return domainRegex.test(String(value)) || message;
		};
	},

	url: (message = 'Please enter a valid URL'): ValidationRule => {
		return (value) => {
			if (!value) return true;
			return isValidUrl(String(value)) || message;
		};
	},
};
