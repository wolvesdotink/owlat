// @vitest-environment happy-dom
/**
 * Where a caller's attributes land on `UiInput`.
 *
 * The root is a container div (label, icons, error text), so Vue's default
 * fallthrough put every attribute the caller passed on that div: `min` on a
 * number field, `name`, `aria-label` and key handlers all missed the actual
 * control. The contract now: `class` and `style` place the container, and
 * everything else belongs to the native <input>.
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick, ref, defineComponent, h } from 'vue';
import UiInput from '../components/ui/Input.vue';

describe('UiInput attribute forwarding', () => {
	it('puts native constraints and form attributes on the input, not the container', () => {
		const wrapper = mount(UiInput, {
			props: { type: 'number', modelValue: 30 },
			attrs: {
				min: 30,
				max: 3650,
				step: 1,
				name: 'reengage-after-days',
				inputmode: 'numeric',
			},
		});

		const input = wrapper.get('input');
		expect(input.attributes('min')).toBe('30');
		expect(input.attributes('max')).toBe('3650');
		expect(input.attributes('step')).toBe('1');
		expect(input.attributes('name')).toBe('reengage-after-days');
		expect(input.attributes('inputmode')).toBe('numeric');

		const root = wrapper.element as HTMLElement;
		for (const attr of ['min', 'max', 'step', 'name', 'inputmode']) {
			expect(root.hasAttribute(attr)).toBe(false);
		}
	});

	it('forwards maxlength, pattern, ARIA and data attributes to the input', () => {
		const wrapper = mount(UiInput, {
			attrs: {
				maxlength: 64,
				pattern: '[a-z0-9-]+',
				'aria-label': 'Slug',
				'data-testid': 'slug-input',
			},
		});

		const input = wrapper.get('input');
		expect(input.attributes('maxlength')).toBe('64');
		expect(input.attributes('pattern')).toBe('[a-z0-9-]+');
		expect(input.attributes('aria-label')).toBe('Slug');
		expect(wrapper.get('[data-testid="slug-input"]').element).toBe(input.element);
		expect((wrapper.element as HTMLElement).hasAttribute('aria-label')).toBe(false);
	});

	it('keeps class and style on the container', () => {
		const wrapper = mount(UiInput, {
			attrs: { class: 'mt-2 sm:flex-1', style: 'max-width: 20rem' },
		});

		const root = wrapper.element as HTMLElement;
		expect(root.tagName).toBe('DIV');
		expect(root.classList.contains('mt-2')).toBe(true);
		expect(root.classList.contains('sm:flex-1')).toBe(true);
		expect(root.getAttribute('style')).toContain('max-width: 20rem');

		const input = wrapper.get('input');
		expect(input.classes()).not.toContain('mt-2');
		expect(input.classes()).toContain('ui-input-control');
		expect(input.attributes('style')).toBeUndefined();
	});

	it('binds focus and key listeners to the input', async () => {
		const calls: string[] = [];
		const wrapper = mount(UiInput, {
			attrs: {
				onFocus: () => calls.push('focus'),
				onKeydown: (event: KeyboardEvent) => calls.push(`keydown:${event.key}`),
			},
		});

		await wrapper.get('input').trigger('focus');
		await wrapper.get('input').trigger('keydown', { key: 'Enter' });
		expect(calls).toEqual(['focus', 'keydown:Enter']);
	});

	it('emits input, model and blur events once each, alongside a caller input listener', async () => {
		const onInput = { count: 0 };
		const wrapper = mount(UiInput, {
			props: { modelValue: '' },
			attrs: { onInput: () => onInput.count++ },
		});

		const input = wrapper.get('input');
		await input.setValue('hello');
		await input.trigger('blur');

		expect(onInput.count).toBe(1);
		expect(wrapper.emitted('update:modelValue')).toEqual([['hello']]);
		expect(wrapper.emitted('blur')).toHaveLength(1);
	});

	it('joins a caller aria-describedby with the error id and keeps derived ARIA state', () => {
		const wrapper = mount(UiInput, {
			props: { id: 'slug', error: 'Taken', required: true },
			attrs: { 'aria-describedby': 'slug-hint' },
		});

		const input = wrapper.get('input');
		expect(input.attributes('aria-describedby')).toBe('slug-hint slug-error');
		expect(input.attributes('aria-invalid')).toBe('true');
		expect(input.attributes('aria-required')).toBe('true');
	});

	it("falls back to the caller's ARIA state when the props set none", () => {
		const wrapper = mount(UiInput, {
			attrs: { 'aria-invalid': 'true', 'aria-required': 'true' },
		});

		const input = wrapper.get('input');
		expect(input.attributes('aria-invalid')).toBe('true');
		expect(input.attributes('aria-required')).toBe('true');
	});

	it('follows attribute changes after mount', async () => {
		const min = ref(30);
		const Host = defineComponent({
			setup: () => () => h(UiInput, { type: 'number', modelValue: 200, min: min.value }),
		});
		const wrapper = mount(Host);
		expect(wrapper.get('input').attributes('min')).toBe('30');

		min.value = 180;
		await nextTick();
		expect(wrapper.get('input').attributes('min')).toBe('180');
	});
});
