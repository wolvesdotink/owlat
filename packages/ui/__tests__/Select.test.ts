// @vitest-environment happy-dom
/**
 * The shared Select is a select-only combobox: focus stays on the trigger, the
 * list is a `listbox` whose current option is named by `aria-activedescendant`,
 * and every way of closing it (pick, Escape, Tab) leaves keyboard users where
 * they were. Mounted for real, driven by keyboard events.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { h, nextTick, type Component } from 'vue';
import Select from '../components/ui/Select.vue';
import { createUiI18n } from './i18n';

const IconStub = { name: 'Icon', setup: () => () => h('i') };

const FRUIT = [
	{ value: 'apple', label: 'Apple' },
	{ value: 'banana', label: 'Banana' },
	{ value: 'blueberry', label: 'Blueberry' },
	{ value: 'cherry', label: 'Cherry' },
	{ value: 'cranberry', label: 'Cranberry' },
];

const mounted: VueWrapper[] = [];

function mountSelect(props: Record<string, unknown> = {}): VueWrapper {
	const wrapper: VueWrapper = mount(Select as Component, {
		props: {
			options: FRUIT,
			modelValue: null,
			label: 'Fruit',
			// v-model, so the selected state follows each pick.
			'onUpdate:modelValue': (value: unknown) => wrapper.setProps({ modelValue: value }),
			...props,
		},
		attachTo: document.body,
		global: {
			plugins: [createUiI18n('en')],
			components: { Icon: IconStub },
		},
	});
	mounted.push(wrapper);
	return wrapper;
}

afterEach(() => {
	for (const wrapper of mounted.splice(0)) wrapper.unmount();
	document.body.innerHTML = '';
});

const trigger = (wrapper: VueWrapper) => wrapper.get<HTMLButtonElement>('[role="combobox"]');
const listbox = () => document.querySelector<HTMLElement>('[role="listbox"]');
const options = () => Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));

/** The option `aria-activedescendant` points at, by label. */
function activeLabel(wrapper: VueWrapper): string | null {
	const id = trigger(wrapper).attributes('aria-activedescendant');
	if (!id) return null;
	return document.getElementById(id)?.textContent?.trim() ?? null;
}

async function press(wrapper: VueWrapper, key: string, init: KeyboardEventInit = {}) {
	const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
	trigger(wrapper).element.dispatchEvent(event);
	await nextTick();
	await nextTick();
	return event;
}

async function focusTrigger(wrapper: VueWrapper) {
	trigger(wrapper).element.focus();
	await nextTick();
}

describe('Select semantics', () => {
	it('exposes a collapsed combobox named by its label', () => {
		const wrapper = mountSelect();
		const button = trigger(wrapper);
		const label = wrapper.get('label');

		expect(button.attributes('aria-haspopup')).toBe('listbox');
		expect(button.attributes('aria-expanded')).toBe('false');
		expect(button.attributes('aria-controls')).toBeUndefined();
		expect(label.attributes('for')).toBe(button.attributes('id'));
		expect(button.attributes('aria-label')).toBeUndefined();
		expect(listbox()).toBeNull();
	});

	it('opens a listbox of options that marks the selected one', async () => {
		const wrapper = mountSelect({ modelValue: 'cherry' });
		await trigger(wrapper).trigger('click');

		const list = listbox()!;
		expect(trigger(wrapper).attributes('aria-expanded')).toBe('true');
		expect(trigger(wrapper).attributes('aria-controls')).toBe(list.id);
		expect(list.getAttribute('aria-labelledby')).toBe(wrapper.get('label').attributes('id'));
		expect(options().map((o) => o.textContent?.trim())).toEqual(FRUIT.map((f) => f.label));
		expect(options().map((o) => o.getAttribute('aria-selected'))).toEqual([
			'false',
			'false',
			'false',
			'true',
			'false',
		]);
	});

	it('ties an error and the required state to the control', () => {
		const wrapper = mountSelect({ error: 'Pick a fruit', required: true });
		const button = trigger(wrapper);

		expect(button.attributes('aria-invalid')).toBe('true');
		expect(button.attributes('aria-required')).toBe('true');
		const describedBy = button.attributes('aria-describedby')!;
		expect(document.getElementById(describedBy)?.textContent).toBe('Pick a fruit');
	});

	it('has no error association without an error', () => {
		const wrapper = mountSelect();
		expect(trigger(wrapper).attributes('aria-invalid')).toBeUndefined();
		expect(trigger(wrapper).attributes('aria-describedby')).toBeUndefined();
	});

	it('names an unlabelled select by its placeholder, or by an explicit aria-label', async () => {
		const byPlaceholder = mountSelect({ label: undefined, placeholder: 'All tags' });
		expect(trigger(byPlaceholder).attributes('aria-label')).toBe('All tags');
		await trigger(byPlaceholder).trigger('click');
		expect(listbox()!.getAttribute('aria-label')).toBe('All tags');

		const named = mountSelect({ label: undefined, ariaLabel: 'Tags' });
		expect(trigger(named).attributes('aria-label')).toBe('Tags');
	});

	it('leaves the name to an outside <label for> when the caller passes an id', () => {
		const wrapper = mountSelect({ label: undefined, id: 'senderPicker' });
		expect(trigger(wrapper).attributes('id')).toBe('senderPicker');
		expect(trigger(wrapper).attributes('aria-label')).toBeUndefined();
	});
});

describe('Select keyboard', () => {
	it('opens on ArrowDown at the selected option, keeping focus on the trigger', async () => {
		const wrapper = mountSelect({ modelValue: 'blueberry' });
		await focusTrigger(wrapper);

		const event = await press(wrapper, 'ArrowDown');

		expect(event.defaultPrevented).toBe(true);
		expect(listbox()).not.toBeNull();
		expect(activeLabel(wrapper)).toBe('Blueberry');
		expect(document.activeElement).toBe(trigger(wrapper).element);
	});

	it.each(['Enter', ' ', 'ArrowUp'])(
		'opens on %j at the first option when nothing is selected',
		async (key) => {
			const wrapper = mountSelect();
			await focusTrigger(wrapper);
			await press(wrapper, key);
			expect(listbox()).not.toBeNull();
			expect(activeLabel(wrapper)).toBe('Apple');
		}
	);

	it('opens on Home and End at the first and last option', async () => {
		const wrapper = mountSelect({ modelValue: 'banana' });
		await press(wrapper, 'End');
		expect(activeLabel(wrapper)).toBe('Cranberry');
		await press(wrapper, 'Escape');
		await press(wrapper, 'Home');
		expect(activeLabel(wrapper)).toBe('Apple');
	});

	it('moves with the arrows, stops at the ends and jumps with Home/End', async () => {
		const wrapper = mountSelect();
		await press(wrapper, 'ArrowDown');

		await press(wrapper, 'ArrowUp');
		expect(activeLabel(wrapper)).toBe('Apple');
		await press(wrapper, 'ArrowDown');
		await press(wrapper, 'ArrowDown');
		expect(activeLabel(wrapper)).toBe('Blueberry');
		await press(wrapper, 'End');
		expect(activeLabel(wrapper)).toBe('Cranberry');
		await press(wrapper, 'ArrowDown');
		expect(activeLabel(wrapper)).toBe('Cranberry');
		await press(wrapper, 'Home');
		expect(activeLabel(wrapper)).toBe('Apple');
		// Moving the highlight does not commit anything.
		expect(wrapper.emitted('update:modelValue')).toBeUndefined();
	});

	it('selects the active option with Enter, closes and keeps focus on the trigger', async () => {
		const wrapper = mountSelect();
		await focusTrigger(wrapper);
		await press(wrapper, 'ArrowDown');
		await press(wrapper, 'ArrowDown');

		const event = await press(wrapper, 'Enter');

		expect(event.defaultPrevented).toBe(true);
		expect(wrapper.emitted('update:modelValue')).toEqual([['banana']]);
		expect(listbox()).toBeNull();
		expect(trigger(wrapper).attributes('aria-expanded')).toBe('false');
		expect(trigger(wrapper).text()).toContain('Banana');
		expect(document.activeElement).toBe(trigger(wrapper).element);
	});

	it('selects the active option with Space', async () => {
		const wrapper = mountSelect();
		await press(wrapper, ' ');
		await press(wrapper, 'End');
		await press(wrapper, ' ');
		expect(wrapper.emitted('update:modelValue')).toEqual([['cranberry']]);
		expect(listbox()).toBeNull();
	});

	it('cancels with Escape: no change, focus restored, and the Escape stops here', async () => {
		const wrapper = mountSelect({ modelValue: 'apple' });
		// A modal listens on the document in capture; a page shortcut on window.
		const dialogEscape = vi.fn();
		const pageShortcut = vi.fn();
		const onDialogKey = (event: KeyboardEvent) => event.key === 'Escape' && dialogEscape();
		const onPageKey = (event: KeyboardEvent) => event.key === 'Escape' && pageShortcut();
		document.addEventListener('keydown', onDialogKey, true);
		window.addEventListener('keydown', onPageKey);
		try {
			await focusTrigger(wrapper);
			await press(wrapper, 'ArrowDown');
			await press(wrapper, 'ArrowDown');

			const event = await press(wrapper, 'Escape');

			expect(event.defaultPrevented).toBe(true);
			expect(dialogEscape).not.toHaveBeenCalled();
			expect(pageShortcut).not.toHaveBeenCalled();
			expect(listbox()).toBeNull();
			expect(wrapper.emitted('update:modelValue')).toBeUndefined();
			expect(document.activeElement).toBe(trigger(wrapper).element);

			// Closed, Escape belongs to the page again.
			await press(wrapper, 'Escape');
			expect(dialogEscape).toHaveBeenCalledTimes(1);
		} finally {
			document.removeEventListener('keydown', onDialogKey, true);
			window.removeEventListener('keydown', onPageKey);
		}
	});

	it('closes on Tab without committing the highlighted option', async () => {
		const wrapper = mountSelect({ modelValue: 'apple' });
		await press(wrapper, 'ArrowDown');
		await press(wrapper, 'ArrowDown');

		const event = await press(wrapper, 'Tab');

		expect(event.defaultPrevented).toBe(false);
		expect(listbox()).toBeNull();
		expect(wrapper.emitted('update:modelValue')).toBeUndefined();
	});

	it('jumps by typed prefix, and a repeated letter cycles its options', async () => {
		vi.useFakeTimers();
		try {
			const wrapper = mountSelect();
			await press(wrapper, 'c');
			expect(listbox()).not.toBeNull();
			expect(activeLabel(wrapper)).toBe('Cherry');
			await press(wrapper, 'c');
			expect(activeLabel(wrapper)).toBe('Cranberry');
			await press(wrapper, 'c');
			expect(activeLabel(wrapper)).toBe('Cherry');

			vi.advanceTimersByTime(600);
			await press(wrapper, 'b');
			expect(activeLabel(wrapper)).toBe('Banana');
			await press(wrapper, 'l');
			expect(activeLabel(wrapper)).toBe('Blueberry');

			vi.advanceTimersByTime(600);
			await press(wrapper, 'z');
			expect(activeLabel(wrapper)).toBe('Blueberry');
		} finally {
			vi.useRealTimers();
		}
	});

	it('ignores the keyboard and the mouse while disabled', async () => {
		const wrapper = mountSelect({ disabled: true });
		expect(trigger(wrapper).attributes('disabled')).toBeDefined();
		for (const key of ['ArrowDown', 'Enter', ' ', 'Home', 'a']) await press(wrapper, key);
		await trigger(wrapper).trigger('click');
		expect(listbox()).toBeNull();
		expect(wrapper.emitted('update:modelValue')).toBeUndefined();
	});

	it('closes when it becomes disabled while open', async () => {
		const wrapper = mountSelect();
		await press(wrapper, 'ArrowDown');
		await wrapper.setProps({ disabled: true });
		expect(listbox()).toBeNull();
	});
});

describe('Select pointer', () => {
	it('returns focus to the trigger after a clicked option', async () => {
		const wrapper = mountSelect();
		await trigger(wrapper).trigger('click');
		const option = options()[2]!;

		const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
		option.dispatchEvent(down);
		// The list never takes focus, so the trigger keeps its keyboard context.
		expect(down.defaultPrevented).toBe(true);
		option.click();
		await nextTick();

		expect(wrapper.emitted('update:modelValue')).toEqual([['blueberry']]);
		expect(listbox()).toBeNull();
		expect(document.activeElement).toBe(trigger(wrapper).element);
	});

	it('lets an outside click keep the element the user clicked', async () => {
		const wrapper = mountSelect();
		const elsewhere = document.createElement('input');
		document.body.appendChild(elsewhere);
		await focusTrigger(wrapper);
		await press(wrapper, 'ArrowDown');

		elsewhere.focus();
		elsewhere.click();
		await nextTick();

		expect(listbox()).toBeNull();
		expect(document.activeElement).toBe(elsewhere);
		expect(wrapper.emitted('update:modelValue')).toBeUndefined();
	});

	it('moves the keyboard highlight to the hovered option', async () => {
		const wrapper = mountSelect();
		await trigger(wrapper).trigger('click');
		options()[3]!.dispatchEvent(new MouseEvent('mouseenter'));
		await nextTick();
		expect(activeLabel(wrapper)).toBe('Cherry');
		await press(wrapper, 'ArrowDown');
		expect(activeLabel(wrapper)).toBe('Cranberry');
	});
});

describe('Select values', () => {
	it('emits numeric option values as numbers and shows the numeric selection', async () => {
		const wrapper = mountSelect({
			options: [
				{ value: 30, label: '30 days' },
				{ value: 90, label: '90 days' },
				{ value: 365, label: '365 days' },
			],
			modelValue: 90,
		});
		expect(trigger(wrapper).text()).toContain('90 days');

		await press(wrapper, 'ArrowDown');
		expect(activeLabel(wrapper)).toBe('90 days');
		await press(wrapper, 'ArrowDown');
		await press(wrapper, 'Enter');

		const emitted = wrapper.emitted('update:modelValue')!;
		expect(emitted).toEqual([[365]]);
		expect(typeof emitted[0]![0]).toBe('number');
	});

	it('does not open an empty list', async () => {
		const wrapper = mountSelect({ options: [] });
		await press(wrapper, 'ArrowDown');
		await trigger(wrapper).trigger('click');
		expect(listbox()).toBeNull();
		expect(trigger(wrapper).attributes('aria-expanded')).toBe('false');
	});
});
