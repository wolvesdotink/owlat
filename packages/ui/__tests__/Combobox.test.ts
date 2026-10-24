/**
 * The shared combobox: a search input that keeps focus while ↑ ↓ Enter work a
 * listbox the caller fills. Inline (the list is the surface) and as a popover
 * under the input; with the built-in list and with a caller-laid-out one.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, h, ref, type Component } from 'vue';
import Combobox from '../components/ui/Combobox.vue';
import Listbox from '../components/ui/Listbox.vue';

enableAutoUnmount(afterEach);

const PEOPLE = ['Ada', 'Adrian', 'Alma', 'Ben'];

function mountCombobox(props: Record<string, unknown> = {}, slots = {}) {
	const query = ref('');
	const picked: string[] = [];
	const results = computed(() =>
		PEOPLE.filter((p) => p.toLowerCase().startsWith(query.value.toLowerCase()))
	);
	const Host = defineComponent({
		setup: () => () =>
			h('form', { onSubmit: (e: Event) => e.preventDefault() }, [
				h(
					Combobox as Component,
					{
						label: 'People',
						inputId: 'who',
						options: results.value,
						optionKey: (p: string) => p.toLowerCase(),
						query: query.value,
						'onUpdate:query': (next: string) => (query.value = next),
						onSelect: (p: string) => {
							picked.push(p);
							query.value = '';
						},
						...props,
					},
					slots
				),
			]),
	});
	const wrapper = mount(Host, { attachTo: document.body });
	return { wrapper, query, picked };
}

const input = (wrapper: ReturnType<typeof mountCombobox>['wrapper']) => wrapper.get('input');
const optionLabels = () =>
	Array.from(document.querySelectorAll('[role="option"]')).map((o) => o.textContent?.trim());

async function press(el: Element, key: string) {
	const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
	el.dispatchEvent(event);
	await flushPromises();
	return event;
}

describe('UiCombobox inline', () => {
	it('is a combobox input controlling a labelled listbox', async () => {
		const { wrapper } = mountCombobox({ inline: true });
		await flushPromises();
		const list = wrapper.get('[role="listbox"]');
		expect(input(wrapper).attributes('role')).toBe('combobox');
		expect(input(wrapper).attributes('aria-expanded')).toBe('true');
		expect(input(wrapper).attributes('aria-controls')).toBe(list.attributes('id'));
		expect(list.attributes('aria-label')).toBe('People');
		expect(input(wrapper).attributes('id')).toBe('who');
	});

	it('moves with ↑ ↓ Home End and picks with Enter, without submitting the form', async () => {
		const { wrapper, picked } = mountCombobox({ inline: true });
		await flushPromises();
		const listId = wrapper.get('[role="listbox"]').attributes('id');
		const el = input(wrapper).element;
		await press(el, 'ArrowDown');
		await press(el, 'ArrowDown');
		expect(el.getAttribute('aria-activedescendant')).toBe(`${listId}-adrian`);
		await press(el, 'End');
		expect(el.getAttribute('aria-activedescendant')).toBe(`${listId}-ben`);
		await press(el, 'Home');
		const enter = await press(el, 'Enter');
		expect(enter.defaultPrevented).toBe(true);
		expect(picked).toEqual(['Ada']);

		// Nothing highlighted: Enter still never submits.
		const again = await press(el, 'Enter');
		expect(again.defaultPrevented).toBe(true);
	});

	it('goes to the last option with End even when nothing is highlighted yet', async () => {
		const { wrapper } = mountCombobox({ inline: true });
		await flushPromises();
		const listId = wrapper.get('[role="listbox"]').attributes('id');
		await press(input(wrapper).element, 'End');
		expect(input(wrapper).attributes('aria-activedescendant')).toBe(`${listId}-ben`);
	});

	it('clears the search with Escape', async () => {
		const { wrapper, query } = mountCombobox({ inline: true });
		await input(wrapper).setValue('al');
		expect(optionLabels()).toEqual(['alma']);
		await press(input(wrapper).element, 'Escape');
		expect(query.value).toBe('');
	});
});

describe('UiCombobox as a popover', () => {
	it('opens on typing with the top result highlighted, and Enter picks it', async () => {
		const { wrapper, picked } = mountCombobox(
			{ autoHighlight: true },
			{
				option: ({ option }: { option: string }) => `${option}!`,
			}
		);
		expect(input(wrapper).attributes('aria-expanded')).toBe('false');
		await input(wrapper).setValue('ad');
		await flushPromises();
		expect(input(wrapper).attributes('aria-expanded')).toBe('true');
		expect(optionLabels()).toEqual(['Ada!', 'Adrian!']);
		const active = input(wrapper).attributes('aria-activedescendant');
		expect(document.getElementById(active!)?.textContent).toBe('Ada!');

		await press(input(wrapper).element, 'ArrowDown');
		await press(input(wrapper).element, 'Enter');
		expect(picked).toEqual(['Adrian']);
		expect(input(wrapper).attributes('aria-expanded')).toBe('false');
	});

	it('stays open for several picks in a row with stay-open', async () => {
		const { wrapper, picked } = mountCombobox({ autoHighlight: true, stayOpen: true });
		await input(wrapper).setValue('a');
		await flushPromises();
		await press(input(wrapper).element, 'Enter');
		await input(wrapper).setValue('b');
		await flushPromises();
		await press(input(wrapper).element, 'Enter');
		expect(picked).toEqual(['Ada', 'Ben']);
	});

	it('opens with ↓ and closes with Escape before anything underneath hears it', async () => {
		const { wrapper } = mountCombobox();
		let pageHeard = 0;
		const onPage = (e: KeyboardEvent) => {
			if (e.key === 'Escape') pageHeard += 1;
		};
		document.addEventListener('keydown', onPage);
		input(wrapper).element.focus();
		await press(input(wrapper).element, 'ArrowDown');
		expect(input(wrapper).attributes('aria-expanded')).toBe('true');
		expect(optionLabels()).toHaveLength(4);

		await press(input(wrapper).element, 'Escape');
		expect(input(wrapper).attributes('aria-expanded')).toBe('false');
		expect(pageHeard).toBe(0);
		await press(input(wrapper).element, 'Escape');
		expect(pageHeard).toBe(1);
		document.removeEventListener('keydown', onPage);
	});
});

describe('UiCombobox and an IME', () => {
	async function compose(el: Element, key: string, init: KeyboardEventInit) {
		const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
		el.dispatchEvent(event);
		await flushPromises();
		return event;
	}

	it('leaves every composing key to the IME, closed or open', async () => {
		const { wrapper, picked } = mountCombobox({ autoHighlight: true });
		const el = input(wrapper).element;
		el.focus();

		// Closed: a composing ↓ neither opens the list nor moves the caret.
		for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
			expect((await compose(el, 'ArrowDown', init)).defaultPrevented).toBe(false);
			expect((await compose(el, 'Enter', init)).defaultPrevented).toBe(false);
		}
		expect(input(wrapper).attributes('aria-expanded')).toBe('false');

		// Open: the confirming Enter (Safari's arrives with keyCode 229 only)
		// does not pick the highlighted option.
		await input(wrapper).setValue('a');
		await flushPromises();
		expect(input(wrapper).attributes('aria-expanded')).toBe('true');
		const highlighted = el.getAttribute('aria-activedescendant');
		expect(highlighted).toBeTruthy();
		for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
			expect((await compose(el, 'Enter', init)).defaultPrevented).toBe(false);
			expect((await compose(el, 'ArrowDown', init)).defaultPrevented).toBe(false);
		}
		expect(picked).toEqual([]);
		expect(el.getAttribute('aria-activedescendant')).toBe(highlighted);
	});

	it('leaves a composing Escape alone in an inline search', async () => {
		const { wrapper, query } = mountCombobox({ inline: true });
		await input(wrapper).setValue('ad');
		const event = await compose(input(wrapper).element, 'Escape', { isComposing: true });
		expect(event.defaultPrevented).toBe(false);
		expect(query.value).toBe('ad');
	});
});

describe('UiCombobox with a caller-laid-out list', () => {
	it('drives a UiListbox placed in its default slot', async () => {
		const picked: string[] = [];
		const Host = defineComponent({
			setup: () => () =>
				h(
					Combobox as Component,
					{ label: 'People', inline: true },
					{
						default: () =>
							h('section', { 'data-testid': 'frame' }, [
								h(Listbox as Component, {
									options: PEOPLE,
									optionKey: (p: string) => p,
									label: 'People',
									onSelect: (p: string) => picked.push(p),
								}),
							]),
					}
				),
		});
		const wrapper = mount(Host, { attachTo: document.body });
		await flushPromises();
		const el = wrapper.get('input').element;
		expect(el.getAttribute('aria-controls')).toBe(
			wrapper.get('[data-testid="frame"] [role="listbox"]').attributes('id')
		);
		await press(el, 'ArrowUp');
		await press(el, 'Enter');
		expect(picked).toEqual(['Ben']);
	});
});
