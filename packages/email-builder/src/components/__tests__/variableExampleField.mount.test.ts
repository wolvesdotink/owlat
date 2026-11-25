// @vitest-environment happy-dom
//
/**
 * The example input of the variable dialogs: an empty field is no example, a
 * list is parsed from its JSON and refused with a message while it is not one
 * a send would accept, and a field without a starting example starts empty.
 */
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import VariableExampleField from '../dialogs/VariableExampleField.vue';

const INVALID = { invalid: true };
const lastChange = (wrapper: ReturnType<typeof mount>) => {
	const result = wrapper.emitted('change')?.at(-1)?.[0] as { valid: boolean; value?: unknown };
	return result.valid ? result.value : INVALID;
};

describe('VariableExampleField', () => {
	it.each(['string', 'number', 'date', 'array'] as const)(
		'starts a %s field empty, with no example',
		(type) => {
			const wrapper = mount(VariableExampleField, { props: { type, inputId: 'x' } });
			const input = wrapper.get('[data-testid="variable-example-input"]');
			expect((input.element as HTMLInputElement).value).toBe('');
			expect(lastChange(wrapper)).toBeUndefined();
		}
	);

	it('reads a boolean, a number and a list as their types', async () => {
		const boolean = mount(VariableExampleField, { props: { type: 'boolean', inputId: 'x' } });
		await boolean.get('select').setValue('false');
		expect(lastChange(boolean)).toBe(false);

		const number = mount(VariableExampleField, { props: { type: 'number', inputId: 'x' } });
		await number.get('input').setValue('42.5');
		expect(lastChange(number)).toBe(42.5);

		const list = mount(VariableExampleField, { props: { type: 'array', inputId: 'x' } });
		await list.get('textarea').setValue('[{"name":"Tent","quantity":1}]');
		expect(lastChange(list)).toEqual([{ name: 'Tent', quantity: 1 }]);
	});

	it('refuses a list that is not JSON, or not one a send accepts', async () => {
		const list = mount(VariableExampleField, { props: { type: 'array', inputId: 'x' } });
		await list.get('textarea').setValue('[{"name": "Tent",}]');
		expect(lastChange(list)).toEqual(INVALID);
		expect(list.get('[role="alert"]').text()).toBe("This isn't valid JSON.");

		await list.get('textarea').setValue('[{"name": {"nested": true}}]');
		expect(lastChange(list)).toEqual(INVALID);
		expect(list.get('[role="alert"]').text()).toContain('up to 500 entries');
	});

	it('accepts the text "invalid" as a string example', async () => {
		const wrapper = mount(VariableExampleField, { props: { type: 'string', inputId: 'x' } });
		await wrapper.get('input').setValue('invalid');
		expect(lastChange(wrapper)).toBe('invalid');
	});

	it('shows a stored timestamp as text, since a date picker cannot hold it', () => {
		const wrapper = mount(VariableExampleField, {
			props: { type: 'date', initial: '2026-11-25T09:30:00Z', inputId: 'x' },
		});
		const input = wrapper.get('input').element as HTMLInputElement;
		expect(input.type).toBe('text');
		expect(input.value).toBe('2026-11-25T09:30:00Z');
		expect(lastChange(wrapper)).toBe('2026-11-25T09:30:00Z');
	});

	it('starts from a stored example', () => {
		const wrapper = mount(VariableExampleField, {
			props: { type: 'boolean', initial: true, inputId: 'x' },
		});
		expect((wrapper.get('select').element as HTMLSelectElement).value).toBe('true');
		expect(lastChange(wrapper)).toBe(true);
	});
});
