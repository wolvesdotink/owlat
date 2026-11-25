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

const lastChange = (wrapper: ReturnType<typeof mount>) => wrapper.emitted('change')?.at(-1)?.[0];

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
		expect(lastChange(list)).toBe('invalid');
		expect(list.get('[role="alert"]').text()).toBe("This isn't valid JSON.");

		await list.get('textarea').setValue('[{"name": {"nested": true}}]');
		expect(lastChange(list)).toBe('invalid');
		expect(list.get('[role="alert"]').text()).toContain('up to 500 entries');
	});

	it('starts from a stored example', () => {
		const wrapper = mount(VariableExampleField, {
			props: { type: 'boolean', initial: true, inputId: 'x' },
		});
		expect((wrapper.get('select').element as HTMLSelectElement).value).toBe('true');
		expect(lastChange(wrapper)).toBe(true);
	});
});
