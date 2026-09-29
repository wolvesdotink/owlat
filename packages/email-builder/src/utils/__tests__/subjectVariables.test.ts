import { describe, it, expect } from 'vitest';
import {
	findSubjectVariableTrigger,
	insertSubjectVariable,
	unknownSubjectVariables,
} from '../subjectVariables';

describe('findSubjectVariableTrigger', () => {
	it('opens on a bare {{ before the caret', () => {
		expect(findSubjectVariableTrigger('Hi {{', 5)).toEqual({
			range: { start: 3, end: 5 },
			query: '',
		});
	});

	it('carries the partial key as the query', () => {
		expect(findSubjectVariableTrigger('Hi {{first', 10)).toEqual({
			range: { start: 3, end: 10 },
			query: 'first',
		});
	});

	it('only looks at the text before the caret', () => {
		expect(findSubjectVariableTrigger('Hi {{first}} there', 10)?.query).toBe('first');
		expect(findSubjectVariableTrigger('Hi {{first}} there', 18)).toBeNull();
	});

	it('does not treat @ or a single brace as a trigger', () => {
		expect(findSubjectVariableTrigger('Meet us @', 9)).toBeNull();
		expect(findSubjectVariableTrigger('Price {', 7)).toBeNull();
	});

	it('closes once the query stops being a key', () => {
		expect(findSubjectVariableTrigger('Hi {{first name', 15)).toBeNull();
	});
});

describe('insertSubjectVariable', () => {
	it('replaces the typed trigger with the full token', () => {
		expect(insertSubjectVariable('Hi {{fir, welcome', 'firstName', { start: 3, end: 8 })).toEqual({
			value: 'Hi {{firstName}}, welcome',
			caret: 16,
		});
	});

	it('inserts at a collapsed caret', () => {
		expect(insertSubjectVariable('Hi !', 'firstName', { start: 3, end: 3 })).toEqual({
			value: 'Hi {{firstName}}!',
			caret: 16,
		});
	});

	it('pads away from a preceding word only when asked', () => {
		expect(
			insertSubjectVariable('Receipt', 'id', { start: 7, end: 7 }, { padBefore: true }).value
		).toBe('Receipt {{id}}');
		expect(insertSubjectVariable('Receipt', 'id', { start: 7, end: 7 }).value).toBe(
			'Receipt{{id}}'
		);
		expect(
			insertSubjectVariable('Receipt ', 'id', { start: 8, end: 8 }, { padBefore: true }).value
		).toBe('Receipt {{id}}');
		expect(insertSubjectVariable('', 'id', { start: 0, end: 0 }, { padBefore: true }).value).toBe(
			'{{id}}'
		);
	});

	it('replaces a selection', () => {
		expect(insertSubjectVariable('Hi NAME', 'name', { start: 3, end: 7 }).value).toBe(
			'Hi {{name}}'
		);
	});
});

describe('unknownSubjectVariables', () => {
	it('lists tokens that name no known variable, once each', () => {
		expect(
			unknownSubjectVariables('{{frstName}}, {{orderId}} and {{frstName}}', ['orderId'])
		).toEqual(['frstName']);
	});

	it('counts fallback tokens by their key', () => {
		expect(unknownSubjectVariables("Hi {{firstName|'there'}}", ['firstName'])).toEqual([]);
	});

	it('is empty for a subject without tokens', () => {
		expect(unknownSubjectVariables('Your receipt', [])).toEqual([]);
	});
});
