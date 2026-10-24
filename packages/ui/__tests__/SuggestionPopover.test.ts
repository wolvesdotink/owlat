/**
 * Suggestions for a text field that keeps focus: the host forwards its keys,
 * the list answers ↑ ↓ Enter Tab, Escape dismisses ahead of anything else, and
 * the field carries the ARIA that names the highlighted option.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h, ref, type Component } from 'vue';
import SuggestionPopover from '../components/ui/SuggestionPopover.vue';

enableAutoUnmount(afterEach);

const HANDLES = ['ada', 'adrian', 'alma'];

function mountHost() {
	const open = ref(true);
	const options = ref(HANDLES);
	const picked: string[] = [];
	const typed: string[] = [];
	const Host = defineComponent({
		setup() {
			const field = ref<HTMLTextAreaElement | null>(null);
			const picker = ref<{
				handleKeydown: (e: KeyboardEvent) => boolean;
				fieldAttrs: Record<string, unknown>;
			} | null>(null);
			return () => [
				h('textarea', {
					ref: field,
					'data-testid': 'field',
					...picker.value?.fieldAttrs,
					onKeydown: (e: KeyboardEvent) => {
						if (picker.value?.handleKeydown(e)) return;
						typed.push(e.key);
					},
				}),
				h(
					SuggestionPopover as Component,
					{
						ref: picker,
						open: open.value,
						options: options.value,
						optionKey: (o: string) => o,
						label: 'Teammates',
						anchor: field.value,
						field: field.value,
						'onUpdate:open': (next: boolean) => (open.value = next),
						onSelect: (o: string) => picked.push(o),
					},
					{ option: ({ option }: { option: string }) => `@${option}` }
				),
			];
		},
	});
	const wrapper = mount(Host, { attachTo: document.body });
	return { wrapper, open, options, picked, typed };
}

async function press(el: Element, key: string) {
	const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
	el.dispatchEvent(event);
	await flushPromises();
	return event;
}

describe('UiSuggestionPopover', () => {
	it('highlights the first suggestion and names it on the field', async () => {
		const { wrapper } = mountHost();
		await flushPromises();
		const field = wrapper.get('[data-testid="field"]');
		const list = document.querySelector('[role="listbox"]')!;
		expect(field.attributes('aria-autocomplete')).toBe('list');
		expect(field.attributes('aria-controls')).toBe(list.id);
		const active = field.attributes('aria-activedescendant')!;
		expect(document.getElementById(active)?.textContent).toBe('@ada');
		expect(document.getElementById(active)?.getAttribute('aria-selected')).toBe('true');
	});

	it('wraps with ↑ ↓, picks with Enter or Tab, and leaves typing to the field', async () => {
		const { wrapper, picked, typed } = mountHost();
		await flushPromises();
		const field = wrapper.get('[data-testid="field"]').element;
		await press(field, 'ArrowUp');
		const enter = await press(field, 'Enter');
		expect(enter.defaultPrevented).toBe(true);
		await press(field, 'ArrowDown');
		await press(field, 'Tab');
		await press(field, 'x');
		expect(picked).toEqual(['alma', 'ada']);
		expect(typed).toEqual(['x']);
	});

	it('is dismissed by Escape, and then gives the field its keys back', async () => {
		const { wrapper, open, typed } = mountHost();
		await flushPromises();
		const field = wrapper.get('[data-testid="field"]');
		await press(field.element, 'Escape');
		expect(open.value).toBe(false);
		expect(field.attributes('aria-controls')).toBeUndefined();
		expect(field.attributes('aria-activedescendant')).toBeUndefined();
		await press(field.element, 'Enter');
		expect(typed).toEqual(['Enter']);
	});

	it('shows nothing, and takes no keys, without suggestions', async () => {
		const { wrapper, options, typed } = mountHost();
		options.value = [];
		await flushPromises();
		expect(document.querySelector('[role="listbox"]')).toBeNull();
		await press(wrapper.get('[data-testid="field"]').element, 'ArrowDown');
		expect(typed).toEqual(['ArrowDown']);
	});

	it('picks on click without taking focus from the field', async () => {
		const { wrapper, picked } = mountHost();
		await flushPromises();
		const field = wrapper.get<HTMLTextAreaElement>('[data-testid="field"]').element;
		field.focus();
		const option = document.querySelectorAll<HTMLElement>('[role="option"]')[1]!;
		const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
		option.dispatchEvent(down);
		option.click();
		await flushPromises();
		expect(down.defaultPrevented).toBe(true);
		expect(picked).toEqual(['adrian']);
		expect(document.activeElement).toBe(field);
	});
});
