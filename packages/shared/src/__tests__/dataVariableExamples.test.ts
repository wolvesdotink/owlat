import { describe, expect, it } from 'vitest';
import {
	dataVariableExampleError,
	dataVariableExamplesFault,
	exampleAsPreviewText,
	examplesForSchema,
} from '../dataVariableExamples';

describe('dataVariableExampleError', () => {
	it.each([
		['string', 'Alex'],
		['number', 0],
		['number', -12.5],
		['boolean', false],
		['date', '2026-11-25'],
		['date', '2026-11-25T09:30:00Z'],
		['date', '2026-11-25T09:30:00.123+01:00'],
		['date', '2028-02-29'],
		['date', '0000-02-29'],
		['array', []],
		['array', ['a', 1, true, null, { name: 'Notebook', quantity: 2, note: null }]],
	])('accepts %s %j', (type, value) => {
		expect(dataVariableExampleError(type, value)).toBeNull();
	});

	it.each([
		['string', 1, 'must be a string'],
		['number', '1', 'must be a number'],
		['number', Number.NaN, 'must be a number'],
		['number', Number.POSITIVE_INFINITY, 'must be a number'],
		['boolean', 'true', 'must be true or false'],
		['date', 1_764_000_000_000, 'must be an ISO date'],
		['date', 'tomorrow', 'must be an ISO date'],
		['date', '2026-13-45', 'must be an ISO date'],
		['date', '2026-02-30', 'must be an ISO date'],
		['date', '2026-04-31T10:00:00Z', 'must be an ISO date'],
		['array', '[]', 'must be a list'],
		['array', [['nested']], 'entry 1 must be'],
		['array', ['ok', { name: { nested: true } }], 'entry 2, field "name"'],
		['array', [{ 'unit-price': 3 }], 'field name holds only letters'],
		['array', [{ $id: 3 }], 'field name holds only letters'],
		['array', Array.from({ length: 501 }, () => 1), 'at most 500 entries'],
	])('refuses %s %j', (type, value, message) => {
		expect(dataVariableExampleError(type, value)).toContain(message);
	});
});

describe('dataVariableExamplesFault', () => {
	it('names an example for an undeclared variable', () => {
		expect(dataVariableExamplesFault({ name: 'string' }, { other: 'x' })).toEqual({
			variable: 'other',
			message: 'The example for "other" names a variable the email does not declare',
		});
	});

	it('does not read a declared variable from the prototype', () => {
		expect(dataVariableExamplesFault({}, { constructor: 'x' })?.variable).toBe('constructor');
	});

	it('measures the cap in UTF-8 bytes, not characters', () => {
		// 6,000 characters, 18,000 bytes.
		expect(dataVariableExamplesFault({ name: 'string' }, { name: '漢'.repeat(6_000) })).toEqual({
			message: expect.stringContaining('too large'),
		});
	});

	it('refuses examples over the size cap', () => {
		expect(dataVariableExamplesFault({ name: 'string' }, { name: 'x'.repeat(16_000) })).toEqual({
			message: expect.stringContaining('too large'),
		});
	});
});

describe('examplesForSchema', () => {
	it('keeps the examples whose variable still has their type', () => {
		expect(
			examplesForSchema(
				{ name: 'string', total: 'string' },
				{ name: 'Alex', total: 3, items: ['a'] }
			)
		).toEqual({ name: 'Alex' });
	});
});

describe('exampleAsPreviewText', () => {
	it('gives the text the preview compares and repeats with', () => {
		expect(exampleAsPreviewText('Alex')).toBe('Alex');
		expect(exampleAsPreviewText(true)).toBe('true');
		expect(exampleAsPreviewText(3)).toBe('3');
		expect(exampleAsPreviewText([{ name: 'a' }])).toBe('[{"name":"a"}]');
	});
});
