import { describe, it, expect } from 'vitest';
import {
	validateDataVariables,
	resolveLanguage,
	selectContent,
	mergeAttachments,
} from '../transactional/dispatch';

// Pre-ADR-0021 the schema arg was a JSON string. The new signature takes the
// parsed object directly (Convex now validates the schema field as a typed
// Record). These cases used to pass `{...}`; they now pass
// the object literal directly.

describe('validateDataVariables', () => {
	describe('no schema defined', () => {
		it('should return valid when schema is undefined', () => {
			const result = validateDataVariables({ foo: 'bar' }, undefined);
			expect(result).toEqual({ valid: true });
		});

		it('should return valid when schema is undefined and no variables', () => {
			const result = validateDataVariables(undefined, undefined);
			expect(result).toEqual({ valid: true });
		});
	});

	describe('invalid schema JSON', () => {
		it('should return valid when schema JSON is malformed', () => {
			const result = validateDataVariables({ foo: 'bar' }, { foo: 'string' } as unknown as Record<string, string>);
			expect(result).toEqual({ valid: true });
		});

		it('should return valid when schema JSON is empty string', () => {
			const result = validateDataVariables({ foo: 'bar' }, undefined);
			expect(result).toEqual({ valid: true });
		});
	});

	describe('no variables provided', () => {
		it('should return valid when variables are undefined', () => {
			const schema = { name: 'string', age: 'number' };
			const result = validateDataVariables(undefined, schema);
			expect(result).toEqual({ valid: true });
		});
	});

	describe('string type validation', () => {
		it('should accept string value for string type', () => {
			const schema = { name: 'string' };
			const result = validateDataVariables({ name: 'John' }, schema);
			expect(result).toEqual({ valid: true });
		});

		it('should reject number value for string type', () => {
			const schema = { name: 'string' };
			const result = validateDataVariables({ name: 42 }, schema);
			expect(result.valid).toBe(false);
			expect(result.error).toContain('"name"');
			expect(result.error).toContain('"string"');
			expect(result.error).toContain('"number"');
		});

		it('should reject boolean value for string type', () => {
			const schema = { name: 'string' };
			const result = validateDataVariables({ name: true }, schema);
			expect(result.valid).toBe(false);
			expect(result.error).toContain('"name"');
		});

		it('should accept empty string for string type', () => {
			const schema = { name: 'string' };
			const result = validateDataVariables({ name: '' }, schema);
			expect(result).toEqual({ valid: true });
		});
	});

	describe('number type validation', () => {
		it('should accept integer for number type', () => {
			const schema = { age: 'number' };
			const result = validateDataVariables({ age: 25 }, schema);
			expect(result).toEqual({ valid: true });
		});

		it('should accept float for number type', () => {
			const schema = { price: 'number' };
			const result = validateDataVariables({ price: 19.99 }, schema);
			expect(result).toEqual({ valid: true });
		});

		it('should accept zero for number type', () => {
			const schema = { count: 'number' };
			const result = validateDataVariables({ count: 0 }, schema);
			expect(result).toEqual({ valid: true });
		});

		it('should accept negative numbers', () => {
			const schema = { offset: 'number' };
			const result = validateDataVariables({ offset: -5 }, schema);
			expect(result).toEqual({ valid: true });
		});

		it('should reject NaN for number type', () => {
			const schema = { age: 'number' };
			const result = validateDataVariables({ age: NaN }, schema);
			expect(result.valid).toBe(false);
			expect(result.error).toContain('"age"');
		});

		it('should reject string for number type', () => {
			const schema = { age: 'number' };
			const result = validateDataVariables({ age: '25' }, schema);
			expect(result.valid).toBe(false);
			expect(result.error).toContain('"age"');
		});
	});

	describe('boolean type validation', () => {
		it('should accept true for boolean type', () => {
			const schema = { active: 'boolean' };
			const result = validateDataVariables({ active: true }, schema);
			expect(result).toEqual({ valid: true });
		});

		it('should accept false for boolean type', () => {
			const schema = { active: 'boolean' };
			const result = validateDataVariables({ active: false }, schema);
			expect(result).toEqual({ valid: true });
		});

		it('should reject string for boolean type', () => {
			const schema = { active: 'boolean' };
			const result = validateDataVariables({ active: 'true' }, schema);
			expect(result.valid).toBe(false);
			expect(result.error).toContain('"active"');
		});

		it('should reject number for boolean type', () => {
			const schema = { active: 'boolean' };
			const result = validateDataVariables({ active: 1 }, schema);
			expect(result.valid).toBe(false);
		});
	});

	describe('date type validation', () => {
		it('should accept ISO date string for date type', () => {
			const schema = { startDate: 'date' };
			const result = validateDataVariables({ startDate: '2024-01-15T10:00:00Z' }, schema);
			expect(result).toEqual({ valid: true });
		});

		it('should accept date-only string for date type', () => {
			const schema = { startDate: 'date' };
			const result = validateDataVariables({ startDate: '2024-01-15' }, schema);
			expect(result).toEqual({ valid: true });
		});

		it('should accept timestamp number for date type', () => {
			const schema = { startDate: 'date' };
			const result = validateDataVariables({ startDate: 1700000000000 }, schema);
			expect(result).toEqual({ valid: true });
		});

		it('should reject invalid date string', () => {
			const schema = { startDate: 'date' };
			const result = validateDataVariables({ startDate: 'not-a-date' }, schema);
			expect(result.valid).toBe(false);
			expect(result.error).toContain('"startDate"');
			expect(result.error).toContain('"date"');
		});

		it('should reject boolean for date type', () => {
			const schema = { startDate: 'date' };
			const result = validateDataVariables({ startDate: true }, schema);
			expect(result.valid).toBe(false);
		});

		it('should accept zero (epoch) for date type', () => {
			const schema = { startDate: 'date' };
			const result = validateDataVariables({ startDate: 0 }, schema);
			expect(result).toEqual({ valid: true });
		});
	});

	describe('unknown type', () => {
		it('should accept any value for unknown type', () => {
			const schema = { custom: 'custom_type' };
			const result = validateDataVariables({ custom: 'anything' }, schema);
			expect(result).toEqual({ valid: true });
		});

		it('should accept number for unknown type', () => {
			const schema = { custom: 'unknown' };
			const result = validateDataVariables({ custom: 42 }, schema);
			expect(result).toEqual({ valid: true });
		});
	});

	describe('missing and null variables', () => {
		it('should skip validation for undefined variable', () => {
			const schema = { name: 'string', age: 'number' };
			const result = validateDataVariables({ name: 'John' }, schema);
			expect(result).toEqual({ valid: true });
		});

		it('should skip validation for null variable', () => {
			const schema = { name: 'string' };
			const result = validateDataVariables({ name: null }, schema);
			expect(result).toEqual({ valid: true });
		});

		it('should accept empty variables object', () => {
			const schema = { name: 'string', age: 'number' };
			const result = validateDataVariables({}, schema);
			expect(result).toEqual({ valid: true });
		});
	});

	describe('multiple variables', () => {
		it('should validate all variables in schema', () => {
			const schema = {
				name: 'string',
				age: 'number',
				active: 'boolean',
				startDate: 'date',
			};
			const result = validateDataVariables(
				{
					name: 'John',
					age: 25,
					active: true,
					startDate: '2024-01-15',
				},
				schema
			);
			expect(result).toEqual({ valid: true });
		});

		it('should fail on first invalid variable', () => {
			const schema = {
				name: 'string',
				age: 'number',
			};
			const result = validateDataVariables(
				{
					name: 42,
					age: 'not a number',
				},
				schema
			);
			expect(result.valid).toBe(false);
			// Should report error for one of the invalid variables
			expect(result.error).toBeDefined();
		});

		it('should allow extra variables not in schema', () => {
			const schema = { name: 'string' };
			const result = validateDataVariables(
				{ name: 'John', extraField: 'ignored' },
				schema
			);
			expect(result).toEqual({ valid: true });
		});
	});
});

describe('resolveLanguage (pure)', () => {
	it('prefers the request language when supported', () => {
		expect(resolveLanguage('de', 'fr', 'en', ['en', 'de', 'fr'])).toBe('de');
	});

	it('falls back to contact language when request is undefined', () => {
		expect(resolveLanguage(undefined, 'fr', 'en', ['en', 'fr'])).toBe('fr');
	});

	it('falls back to template default when request + contact are undefined', () => {
		expect(resolveLanguage(undefined, undefined, 'de', ['de', 'en'])).toBe('de');
	});

	it("falls back to 'en' when nothing is set", () => {
		expect(resolveLanguage(undefined, undefined, undefined, ['en'])).toBe('en');
	});

	it('falls back to template default when request language is not in availableLanguages', () => {
		expect(resolveLanguage('ja', undefined, 'en', ['en', 'de'])).toBe('en');
	});

	it('always allows the template default even when not in availableLanguages', () => {
		// edge case: template default missing from supportedLanguages list — still allowed
		expect(resolveLanguage('en', undefined, 'en', ['de'])).toBe('en');
	});
});

describe('selectContent (pure)', () => {
	it('returns default content + subject when language matches template default', () => {
		const out = selectContent(
			'en',
			'en',
			'<p>default</p>',
			'Default subject',
			undefined,
		);
		expect(out.html).toBe('<p>default</p>');
		expect(out.subject).toBe('Default subject');
		expect(out.resolvedLanguage).toBe('en');
	});

	it('returns default content when no translations JSON is set', () => {
		const out = selectContent('de', 'en', '<p>default</p>', 'Default', undefined);
		expect(out.html).toBe('<p>default</p>');
		expect(out.subject).toBe('Default');
		expect(out.resolvedLanguage).toBe('en');
	});

	it('picks the translated content + subject when available', () => {
		const translations = JSON.stringify({
			de: { htmlContent: '<p>Hallo</p>', subject: 'Hallo' },
		});
		const out = selectContent('de', 'en', '<p>Hi</p>', 'Hi', translations);
		expect(out.html).toBe('<p>Hallo</p>');
		expect(out.subject).toBe('Hallo');
		expect(out.resolvedLanguage).toBe('de');
	});

	it('falls back to default when the language has no translation entry', () => {
		const translations = JSON.stringify({
			de: { htmlContent: '<p>Hallo</p>', subject: 'Hallo' },
		});
		const out = selectContent('fr', 'en', '<p>Hi</p>', 'Hi', translations);
		expect(out.html).toBe('<p>Hi</p>');
		expect(out.subject).toBe('Hi');
		expect(out.resolvedLanguage).toBe('en');
	});

	it('falls back to default when translations JSON is malformed', () => {
		const out = selectContent('de', 'en', '<p>Hi</p>', 'Hi', 'not-json');
		expect(out.html).toBe('<p>Hi</p>');
		expect(out.subject).toBe('Hi');
		expect(out.resolvedLanguage).toBe('en');
	});
});

describe('mergeAttachments (pure)', () => {
	it('returns undefined when both sources are empty', () => {
		expect(mergeAttachments(undefined, undefined)).toBeUndefined();
	});

	it('returns only request attachments when template has none', () => {
		const reqs = [{ filename: 'a.pdf', url: 'https://example.com/a.pdf' }];
		expect(mergeAttachments(undefined, reqs)).toEqual([
			{ filename: 'a.pdf', contentType: undefined, url: 'https://example.com/a.pdf' },
		]);
	});

	it('returns only template attachments when request has none', () => {
		const tpl = JSON.stringify([
			{ filename: 't.pdf', url: 'https://example.com/t.pdf' },
		]);
		expect(mergeAttachments(tpl, undefined)).toEqual([
			{ filename: 't.pdf', contentType: undefined, url: 'https://example.com/t.pdf' },
		]);
	});

	it('concatenates template + request with template first', () => {
		const tpl = JSON.stringify([
			{ filename: 't.pdf', url: 'https://example.com/t.pdf' },
		]);
		const reqs = [{ filename: 'r.pdf', url: 'https://example.com/r.pdf' }];
		const merged = mergeAttachments(tpl, reqs);
		expect(merged?.map((a) => a.filename)).toEqual(['t.pdf', 'r.pdf']);
	});

	it('ignores malformed template JSON gracefully', () => {
		const reqs = [{ filename: 'r.pdf', url: 'https://example.com/r.pdf' }];
		const merged = mergeAttachments('not-json', reqs);
		expect(merged?.map((a) => a.filename)).toEqual(['r.pdf']);
	});
});
