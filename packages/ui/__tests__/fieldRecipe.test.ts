/**
 * One field look, defined once.
 *
 * `.input` in assets/css/components.css is the field recipe that native
 * controls in the app carry. UiInput, UiTextarea and the UiSelect trigger used
 * to spell their own copy of it, and the copies drifted (different radius,
 * different textarea padding and font size). Each primitive now composes the
 * recipe and its `input-sm` / `input-error` modifiers, and none of them
 * re-declares what the recipe owns.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { h, type Component } from 'vue';
import UiInput from '../components/ui/Input.vue';
import UiSelect from '../components/ui/Select.vue';
import UiTextarea from '../components/ui/Textarea.vue';
import { createUiI18n } from './i18n';

const mounted: VueWrapper[] = [];

afterEach(() => {
	for (const wrapper of mounted.splice(0)) wrapper.unmount();
});

function mountWith(component: Component, props: Record<string, unknown> = {}, slots = {}) {
	const wrapper = mount(component, {
		props,
		slots,
		attachTo: document.body,
		global: {
			plugins: [createUiI18n('en')],
			components: { Icon: { name: 'Icon', setup: () => () => h('i') } },
		},
	});
	mounted.push(wrapper);
	return wrapper;
}

const classesOf = (wrapper: VueWrapper, selector: string) => wrapper.get(selector).classes().sort();

describe('UiInput composes the field recipe', () => {
	it('is a plain .input at the default size', () => {
		expect(classesOf(mountWith(UiInput), 'input')).toEqual(['input']);
	});

	it('adds input-sm and input-error for the small size and an error', () => {
		const wrapper = mountWith(UiInput, { size: 'sm', error: 'Required' });
		expect(classesOf(wrapper, 'input')).toEqual(['input', 'input-error', 'input-sm']);
	});

	it('keeps only one-sided room for an icon on top of the recipe', () => {
		const wrapper = mountWith(UiInput, {}, { iconLeft: () => h('svg') });
		expect(classesOf(wrapper, 'input')).toEqual(['input', 'pl-10']);
	});
});

describe('UiTextarea composes the field recipe', () => {
	it('is a .input with its resize mode at the default size', () => {
		expect(classesOf(mountWith(UiTextarea), 'textarea')).toEqual(['input', 'resize-none']);
	});

	it('adds input-sm and input-error for the small size and an error', () => {
		const wrapper = mountWith(UiTextarea, { size: 'sm', error: 'Too long', resize: 'vertical' });
		expect(classesOf(wrapper, 'textarea')).toEqual([
			'input',
			'input-error',
			'input-sm',
			'resize-y',
		]);
	});
});

describe('UiSelect trigger composes the field recipe', () => {
	const OPTIONS = [
		{ value: 'a', label: 'Alpha' },
		{ value: 'b', label: 'Bravo' },
	];
	const trigger = (wrapper: VueWrapper) => wrapper.get('[role="combobox"]');

	it('wears .input, with input-sm and input-error as modifiers', () => {
		const plain = trigger(mountWith(UiSelect, { options: OPTIONS }));
		expect(plain.classes()).toContain('input');
		expect(plain.classes()).not.toContain('input-sm');

		const small = trigger(mountWith(UiSelect, { options: OPTIONS, size: 'sm', error: 'Pick one' }));
		expect(small.classes()).toEqual(expect.arrayContaining(['input', 'input-sm', 'input-error']));
	});

	it('keeps the brand ring while the list is open', async () => {
		const wrapper = mountWith(UiSelect, { options: OPTIONS });
		await trigger(wrapper).trigger('click');
		expect(trigger(wrapper).classes()).toEqual(expect.arrayContaining(['ring-1', 'ring-brand']));
	});
});

describe('the recipe lives in one place', () => {
	const read = (path: string) => readFileSync(resolve(import.meta.dirname, '..', path), 'utf8');

	// Utilities only the recipe may set on a field: its surface, radius, focus
	// ring colour and padding. A primitive that spells one again has started a
	// second copy of the field look.
	it.each(['components/ui/Input.vue', 'components/ui/Textarea.vue', 'components/ui/Select.vue'])(
		'%s does not re-declare the field surface',
		(path) => {
			const script = read(path).split('<template>')[0] ?? '';
			const classLists = script.match(/'[^']*'/g) ?? [];
			const redeclared = classLists.filter((literal) =>
				/(?<![\w-])(?:bg-surface-1|rounded-(?:lg|xl)|focus:ring-brand|px-[34]|py-[23])(?![\w-])/.test(
					literal
				)
			);
			expect(redeclared).toEqual([]);
		}
	);

	it('draws the focus ring on focus-within, so a wrapper around a bare control shows it', () => {
		const css = read('assets/css/components.css');
		const recipe = /\.input \{\s*@apply ([^;]*);/.exec(css)?.[1] ?? '';
		expect(recipe.split(/\s+/)).toEqual(
			expect.arrayContaining(['bg-surface-1', 'rounded-lg', 'focus-within:ring-brand'])
		);
		expect(recipe).not.toMatch(/(?<![\w-])focus:ring/);
	});
});
