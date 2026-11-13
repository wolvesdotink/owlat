// @vitest-environment happy-dom

/**
 * The builder's property dropdown: reachable and operable from the keyboard,
 * and a scroll inside its own (teleported) list does not close it.
 */
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { describe, expect, it } from 'vitest';
import SelectField from '../SelectField.vue';

const options = [
	{ label: 'Solid', value: 'solid' },
	{ label: 'Dashed', value: 'dashed' },
	{ label: 'Dotted', value: 'dotted' },
];

function mountSelect(value = 'dashed') {
	return mount(SelectField, {
		props: { value, options, label: 'Border style' },
		attachTo: document.body,
	});
}

const listbox = () => document.body.querySelector<HTMLElement>('[role="listbox"]');
const optionButtons = () =>
	Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="option"]'));

describe('SelectField', () => {
	it('names the trigger with the setting and its current value', () => {
		const w = mountSelect();
		expect(w.get('button').attributes('aria-label')).toBe('Border style: Dashed');
	});

	it('opens on ArrowDown, focuses the selected option and moves with the arrows', async () => {
		const w = mountSelect();
		await w.get('button').trigger('keydown', { key: 'ArrowDown' });
		await nextTick();

		expect(listbox()).not.toBeNull();
		expect(document.activeElement).toBe(optionButtons()[1]);

		listbox()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
		expect(document.activeElement).toBe(optionButtons()[2]);

		listbox()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
		expect(document.activeElement).toBe(optionButtons()[0]);
	});

	it('picks with a click and hands focus back to the trigger', async () => {
		const w = mountSelect();
		await w.get('button').trigger('keydown', { key: 'ArrowDown' });
		await nextTick();

		optionButtons()[2]!.click();
		await nextTick();

		expect(w.emitted('update')).toEqual([['dotted']]);
		expect(listbox()).toBeNull();
		expect(document.activeElement).toBe(w.get('button').element);
	});

	it('closes on Escape and returns focus to the trigger', async () => {
		const w = mountSelect();
		await w.get('button').trigger('keydown', { key: 'ArrowDown' });
		await nextTick();

		listbox()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await nextTick();

		expect(listbox()).toBeNull();
		expect(document.activeElement).toBe(w.get('button').element);
		expect(w.emitted('update')).toBeUndefined();
	});

	it('stays open while its own list scrolls, and closes when the page scrolls', async () => {
		const w = mountSelect();
		await w.get('button').trigger('click');
		await nextTick();

		listbox()!.dispatchEvent(new Event('scroll'));
		await nextTick();
		expect(listbox()).not.toBeNull();

		document.dispatchEvent(new Event('scroll'));
		await nextTick();
		expect(listbox()).toBeNull();
	});
});
