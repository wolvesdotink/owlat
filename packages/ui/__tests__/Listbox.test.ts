/**
 * The shared listbox on Reka UI, in both of its modes: focus inside the list,
 * and driven from a field that keeps focus (`virtual-focus`). Mounted for real
 * and driven by keyboard and pointer events.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h, nextTick, ref, type Component } from 'vue';
import Listbox from '../components/ui/Listbox.vue';

enableAutoUnmount(afterEach);

interface Fruit {
	id: string;
	name: string;
	soldOut?: boolean;
}

const FRUIT: Fruit[] = [
	{ id: 'apple', name: 'Apple' },
	{ id: 'banana', name: 'Banana', soldOut: true },
	{ id: 'cherry', name: 'Cherry' },
	{ id: 'date', name: 'Date' },
];

/** A text field driving a listbox, the way a combobox host does. */
function mountDriven(props: Record<string, unknown> = {}) {
	const picked: Fruit[] = [];
	const options = ref<Fruit[]>(FRUIT);
	const Host = defineComponent({
		setup(_, { expose }) {
			const list = ref<{
				handleKeydown: (e: KeyboardEvent, keys?: object) => boolean;
				activeDescendant: string | undefined;
				listId: string;
			} | null>(null);
			const consumed = ref<boolean[]>([]);
			expose({ consumed });
			return () =>
				h('div', [
					h('input', {
						'data-testid': 'field',
						'aria-activedescendant': list.value?.activeDescendant,
						onKeydown: (e: KeyboardEvent) =>
							consumed.value.push(list.value?.handleKeydown(e, { tab: true }) ?? false),
					}),
					h(
						Listbox as Component,
						{
							ref: list,
							options: options.value,
							optionKey: (f: Fruit) => f.id,
							optionDisabled: (f: Fruit) => !!f.soldOut,
							label: 'Fruit',
							id: 'fruit',
							virtualFocus: true,
							onSelect: (f: Fruit) => picked.push(f),
							...props,
						},
						{ option: ({ option }: { option: Fruit }) => option.name }
					),
				]);
		},
	});
	const wrapper = mount(Host, { attachTo: document.body });
	return { wrapper, picked, options };
}

const field = (wrapper: ReturnType<typeof mountDriven>['wrapper']) =>
	wrapper.get('[data-testid="field"]');

describe('UiListbox driven from a field', () => {
	it('is a labelled listbox whose options carry stable ids', async () => {
		const { wrapper } = mountDriven();
		await flushPromises();
		const list = wrapper.get('[role="listbox"]');
		expect(list.attributes('id')).toBe('fruit');
		expect(list.attributes('aria-label')).toBe('Fruit');
		expect(wrapper.findAll('[role="option"]').map((o) => o.attributes('id'))).toEqual([
			'fruit-apple',
			'fruit-banana',
			'fruit-cherry',
			'fruit-date',
		]);
	});

	it('highlights nothing until the keyboard moves, then skips disabled options', async () => {
		const { wrapper } = mountDriven();
		await flushPromises();
		expect(field(wrapper).attributes('aria-activedescendant')).toBeUndefined();

		await field(wrapper).trigger('keydown', { key: 'ArrowDown' });
		expect(field(wrapper).attributes('aria-activedescendant')).toBe('fruit-apple');
		await field(wrapper).trigger('keydown', { key: 'ArrowDown' });
		expect(field(wrapper).attributes('aria-activedescendant')).toBe('fruit-cherry');
		// Focus never left the field.
		expect(document.activeElement).not.toBe(wrapper.get('#fruit-cherry').element);
	});

	it('picks the highlighted option with Enter and Tab, and leaves other keys to the field', async () => {
		const { wrapper, picked } = mountDriven();
		await flushPromises();
		await field(wrapper).trigger('keydown', { key: 'Enter' });
		expect(picked).toEqual([]);

		await field(wrapper).trigger('keydown', { key: 'ArrowDown' });
		await field(wrapper).trigger('keydown', { key: 'Enter' });
		await field(wrapper).trigger('keydown', { key: 'ArrowDown' });
		await field(wrapper).trigger('keydown', { key: 'Tab' });
		expect(picked.map((f) => f.id)).toEqual(['apple', 'cherry']);

		await field(wrapper).trigger('keydown', { key: 'a' });
		await field(wrapper).trigger('keydown', { key: 'Home' });
		const consumed = (wrapper.vm as unknown as { consumed: boolean[] }).consumed;
		expect(consumed).toEqual([false, true, true, true, true, false, false]);
	});

	it('leaves an IME composition its Enter and arrows', async () => {
		const { wrapper, picked } = mountDriven();
		await flushPromises();
		await field(wrapper).trigger('keydown', { key: 'ArrowDown' });
		const enter = new KeyboardEvent('keydown', {
			key: 'Enter',
			isComposing: true,
			cancelable: true,
		});
		field(wrapper).element.dispatchEvent(enter);
		const arrow = new KeyboardEvent('keydown', {
			key: 'ArrowDown',
			keyCode: 229,
			cancelable: true,
		});
		field(wrapper).element.dispatchEvent(arrow);
		await nextTick();
		expect(enter.defaultPrevented).toBe(false);
		expect(arrow.defaultPrevented).toBe(false);
		expect(picked).toEqual([]);
		expect(field(wrapper).attributes('aria-activedescendant')).toBe('fruit-apple');
	});

	it('marks the highlighted option selected when no v-model is bound', async () => {
		const { wrapper } = mountDriven();
		await flushPromises();
		await field(wrapper).trigger('keydown', { key: 'ArrowUp' });
		const selected = wrapper.findAll('[role="option"][aria-selected="true"]');
		expect(selected.map((o) => o.attributes('id'))).toEqual(['fruit-date']);
	});

	it('marks the v-model selection, not the highlight, when one is bound', async () => {
		const { wrapper } = mountDriven({ modelValue: 'cherry' });
		await flushPromises();
		await field(wrapper).trigger('keydown', { key: 'ArrowDown' });
		const selected = wrapper.findAll('[role="option"][aria-selected="true"]');
		expect(selected.map((o) => o.attributes('id'))).toEqual(['fruit-cherry']);
		expect(field(wrapper).attributes('aria-activedescendant')).toBe('fruit-apple');
	});

	it('takes the highlight from the pointer, and keeps the field focused on a click', async () => {
		const { wrapper, picked } = mountDriven();
		await flushPromises();
		const cherry = wrapper.get('#fruit-cherry');
		await cherry.trigger('pointermove');
		expect(field(wrapper).attributes('aria-activedescendant')).toBe('fruit-cherry');
		const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
		cherry.element.dispatchEvent(down);
		expect(down.defaultPrevented).toBe(true);
		await cherry.trigger('click');
		expect(picked.map((f) => f.id)).toEqual(['cherry']);
	});

	it('never picks a disabled option', async () => {
		const { wrapper, picked } = mountDriven();
		await flushPromises();
		await wrapper.get('#fruit-banana').trigger('click');
		expect(picked).toEqual([]);
	});

	it('drops a highlight whose option went away, and keys on the empty list are the field’s', async () => {
		const { wrapper, options } = mountDriven();
		await flushPromises();
		await field(wrapper).trigger('keydown', { key: 'ArrowDown' });
		options.value = [{ id: 'elder', name: 'Elderberry' }];
		await flushPromises();
		expect(field(wrapper).attributes('aria-activedescendant')).toBeUndefined();

		options.value = [];
		await flushPromises();
		const down = new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true });
		field(wrapper).element.dispatchEvent(down);
		expect(down.defaultPrevented).toBe(false);
	});

	it('with auto-highlight keeps the first option highlighted as the options change', async () => {
		const { wrapper, options } = mountDriven({ autoHighlight: true, loop: true });
		await flushPromises();
		expect(field(wrapper).attributes('aria-activedescendant')).toBe('fruit-apple');
		await field(wrapper).trigger('keydown', { key: 'ArrowUp' });
		expect(field(wrapper).attributes('aria-activedescendant')).toBe('fruit-date');

		options.value = FRUIT.slice(2);
		await flushPromises();
		expect(field(wrapper).attributes('aria-activedescendant')).toBe('fruit-cherry');
	});

	it('with auto-highlight keeps the highlight when the pointer leaves the list', async () => {
		const { wrapper } = mountDriven({ autoHighlight: true });
		await flushPromises();
		await wrapper.get('#fruit-cherry').trigger('pointermove');
		wrapper.get('#fruit').element.parentElement!.dispatchEvent(new PointerEvent('pointerleave'));
		await flushPromises();
		expect(field(wrapper).attributes('aria-activedescendant')).toBe('fruit-cherry');
	});

	it('re-renders an option whose content changed under the same key', async () => {
		const { wrapper, options } = mountDriven();
		await flushPromises();
		options.value = [{ id: 'apple', name: 'Green apple' }];
		await flushPromises();
		expect(wrapper.get('#fruit-apple').text()).toBe('Green apple');
	});
});

describe('UiListbox with focus inside', () => {
	it('selects several options with multiple', async () => {
		const value = ref<string[]>([]);
		const wrapper = mount(Listbox as Component, {
			props: {
				options: FRUIT,
				optionKey: (f: Fruit) => f.id,
				label: 'Fruit',
				multiple: true,
				modelValue: value.value,
				'onUpdate:modelValue': (next: string[]) => {
					value.value = next;
					void wrapper.setProps({ modelValue: next });
				},
			},
			slots: { option: ({ option }: { option: Fruit }) => option.name },
			attachTo: document.body,
		});
		await flushPromises();
		expect(wrapper.get('[role="listbox"]').attributes('aria-multiselectable')).toBe('true');
		await wrapper.findAll('[role="option"]')[0]!.trigger('click');
		await wrapper.findAll('[role="option"]')[2]!.trigger('click');
		expect(value.value).toEqual(['apple', 'cherry']);
		await wrapper.findAll('[role="option"]')[0]!.trigger('click');
		expect(value.value).toEqual(['cherry']);
		expect(wrapper.findAll('[role="option"]').map((o) => o.text())).toEqual([
			'Apple',
			'Banana',
			'Cherry',
			'Date',
		]);
	});
});
