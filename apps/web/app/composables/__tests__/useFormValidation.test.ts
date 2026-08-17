import { describe, it, expect } from 'vitest';
import { createTestI18n } from '~/__tests__/i18n';
import { useFormValidation, rules } from '../useFormValidation';

/**
 * A rule's DEFAULT message is an i18n key (module scope can't call `t`), which
 * the surface rendering the error resolves — passing the counts the `{min}` /
 * `{max}` messages interpolate. `copy()` does exactly that here, so every
 * assertion below still reads the English sentence a member is shown.
 */
const { t } = createTestI18n().global;
const copy = (result: string | true, params?: Record<string, unknown>): string | true =>
	typeof result === 'string' ? t(result, params ?? {}) : result;

describe('useFormValidation', () => {
	describe('validate', () => {
		it('returns true with no schema', () => {
			const { validate } = useFormValidation();
			expect(validate({ name: '' })).toBe(true);
		});

		it('validates all fields against the schema', () => {
			const { validate, errors } = useFormValidation({
				name: rules.required(),
				email: rules.email(),
			});

			expect(validate({ name: '', email: 'bad' })).toBe(false);
			expect(copy(errors.value.name!)).toBe('This field is required');
			expect(copy(errors.value.email!)).toBe('Please enter a valid email address');
		});

		it('returns true when all fields pass', () => {
			const { validate } = useFormValidation({
				name: rules.required(),
				email: rules.email(),
			});

			expect(validate({ name: 'John', email: 'john@example.com' })).toBe(true);
		});

		it('clears previous errors before re-validating', () => {
			const { validate, errors } = useFormValidation({
				name: rules.required(),
			});

			validate({ name: '' });
			expect(errors.value.name).toBeDefined();

			validate({ name: 'John' });
			expect(errors.value.name).toBeUndefined();
		});

		it('supports multiple rules per field (array)', () => {
			const { validate, errors } = useFormValidation({
				password: [rules.required(), rules.minLength(8)],
			});

			expect(validate({ password: '' })).toBe(false);
			expect(copy(errors.value.password!)).toBe('This field is required');

			expect(validate({ password: 'abc' })).toBe(false);
			expect(copy(errors.value.password!, { min: 8 })).toBe('Must be at least 8 characters');

			expect(validate({ password: 'abcdefgh' })).toBe(true);
		});
	});

	describe('validateField', () => {
		it('returns true for field not in schema', () => {
			const { validateField } = useFormValidation({ name: rules.required() });
			expect(validateField('unknown', '')).toBe(true);
		});

		it('sets error for invalid field', () => {
			const { validateField, errors } = useFormValidation({
				name: rules.required(),
			});

			expect(validateField('name', '')).toBe(false);
			expect(copy(errors.value.name!)).toBe('This field is required');
		});

		it('clears error for valid field', () => {
			const { validateField, errors } = useFormValidation({
				name: rules.required(),
			});

			validateField('name', '');
			expect(errors.value.name).toBeDefined();

			validateField('name', 'John');
			expect(errors.value.name).toBeUndefined();
		});
	});

	describe('touch / isTouched / getError', () => {
		it('fields are untouched by default', () => {
			const { isTouched } = useFormValidation();
			expect(isTouched('name')).toBe(false);
		});

		it('marks field as touched', () => {
			const { touch, isTouched } = useFormValidation();
			touch('name');
			expect(isTouched('name')).toBe(true);
		});

		it('getError returns undefined for untouched field with error', () => {
			const { validateField, getError } = useFormValidation({
				name: rules.required(),
			});

			validateField('name', '');
			expect(getError('name')).toBeUndefined();
		});

		it('getError returns error for touched field', () => {
			const { validateField, touch, getError } = useFormValidation({
				name: rules.required(),
			});

			validateField('name', '');
			touch('name');
			expect(copy(getError('name')!)).toBe('This field is required');
		});

		it('getError returns error when showAll is true regardless of touch', () => {
			const { validateField, getError } = useFormValidation({
				name: rules.required(),
			});

			validateField('name', '');
			expect(copy(getError('name', true)!)).toBe('This field is required');
		});
	});

	describe('setError / clearError / clearErrors', () => {
		it('sets a custom error', () => {
			const { setError, errors } = useFormValidation();
			setError('email', 'Already in use');
			expect(errors.value.email).toBe('Already in use');
		});

		it('clears a single error', () => {
			const { setError, clearError, errors } = useFormValidation();
			setError('email', 'Error');
			clearError('email');
			expect(errors.value.email).toBeUndefined();
		});

		it('clears all errors', () => {
			const { setError, clearErrors, errors } = useFormValidation();
			setError('a', 'Error A');
			setError('b', 'Error B');
			clearErrors();
			expect(Object.keys(errors.value)).toHaveLength(0);
		});
	});

	describe('hasErrors / hasError', () => {
		it('hasErrors is false initially', () => {
			const { hasErrors } = useFormValidation();
			expect(hasErrors.value).toBe(false);
		});

		it('hasErrors is true when errors exist', () => {
			const { setError, hasErrors } = useFormValidation();
			setError('name', 'Required');
			expect(hasErrors.value).toBe(true);
		});

		it('hasError returns true for field with error', () => {
			const { setError, hasError } = useFormValidation();
			setError('name', 'Required');
			expect(hasError('name')).toBe(true);
			expect(hasError('email')).toBe(false);
		});
	});

	describe('reset', () => {
		it('clears errors and touched state', () => {
			const { setError, touch, reset, errors, isTouched, hasErrors } = useFormValidation();
			setError('name', 'Error');
			touch('name');

			reset();

			expect(hasErrors.value).toBe(false);
			expect(isTouched('name')).toBe(false);
			expect(Object.keys(errors.value)).toHaveLength(0);
		});
	});
});

describe('rules', () => {
	describe('required', () => {
		const rule = rules.required();

		it('fails for null', () => {
			expect(copy(rule(null as unknown as string))).toBe('This field is required');
		});

		it('fails for undefined', () => {
			expect(copy(rule(undefined as unknown as string))).toBe('This field is required');
		});

		it('fails for empty string', () => {
			expect(copy(rule(''))).toBe('This field is required');
		});

		it('fails for empty array', () => {
			expect(copy(rule([] as unknown as string))).toBe('This field is required');
		});

		it('passes for non-empty string', () => {
			expect(rule('hello')).toBe(true);
		});

		it('uses custom message', () => {
			const custom = rules.required('Fill this in');
			expect(custom('')).toBe('Fill this in');
		});
	});

	describe('email', () => {
		const rule = rules.email();

		it('passes for valid email', () => {
			expect(rule('user@example.com')).toBe(true);
		});

		it('passes for empty value (optional)', () => {
			expect(rule('')).toBe(true);
		});

		it('fails for invalid email', () => {
			expect(copy(rule('not-an-email'))).toBe('Please enter a valid email address');
		});

		it('fails for missing domain', () => {
			expect(copy(rule('user@'))).toBe('Please enter a valid email address');
		});
	});

	describe('minLength', () => {
		const rule = rules.minLength(5);

		it('passes when meeting minimum', () => {
			expect(rule('hello')).toBe(true);
		});

		it('passes for empty value (optional)', () => {
			expect(rule('')).toBe(true);
		});

		it('fails when too short', () => {
			expect(copy(rule('hi'), { min: 5 })).toBe('Must be at least 5 characters');
		});

		it('uses custom message', () => {
			const custom = rules.minLength(3, 'Too short');
			expect(custom('ab')).toBe('Too short');
		});
	});

	describe('maxLength', () => {
		const rule = rules.maxLength(5);

		it('passes when under max', () => {
			expect(rule('hi')).toBe(true);
		});

		it('passes for empty value (optional)', () => {
			expect(rule('')).toBe(true);
		});

		it('fails when too long', () => {
			expect(copy(rule('too long string'), { max: 5 })).toBe('Must be no more than 5 characters');
		});

		it('uses custom message', () => {
			const custom = rules.maxLength(3, 'Too long');
			expect(custom('abcd')).toBe('Too long');
		});
	});

	describe('pattern', () => {
		const rule = rules.pattern(/^\d+$/, 'Numbers only');

		it('passes for matching pattern', () => {
			expect(rule('123')).toBe(true);
		});

		it('passes for empty value (optional)', () => {
			expect(rule('')).toBe(true);
		});

		it('fails for non-matching pattern', () => {
			expect(rule('abc')).toBe('Numbers only');
		});
	});

	describe('domain', () => {
		const rule = rules.domain();

		it('passes for valid domain', () => {
			expect(rule('example.com')).toBe(true);
		});

		it('passes for subdomain', () => {
			expect(rule('mail.example.com')).toBe(true);
		});

		it('passes for empty value (optional)', () => {
			expect(rule('')).toBe(true);
		});

		it('fails for domain starting with hyphen', () => {
			expect(copy(rule('-example.com'))).toBe('Please enter a valid domain name');
		});

		it('fails for domain with spaces', () => {
			expect(copy(rule('exam ple.com'))).toBe('Please enter a valid domain name');
		});
	});

	describe('url', () => {
		const rule = rules.url();

		it('passes for valid URL', () => {
			expect(rule('https://example.com')).toBe(true);
		});

		it('passes for empty value (optional)', () => {
			expect(rule('')).toBe(true);
		});

		it('fails for invalid URL', () => {
			expect(copy(rule('not-a-url'))).toBe('Please enter a valid URL');
		});
	});
});
