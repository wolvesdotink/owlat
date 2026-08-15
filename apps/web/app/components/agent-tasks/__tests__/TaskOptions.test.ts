// @vitest-environment happy-dom
/**
 * TaskOptions — the shared single-select chips + free-text input of an agent
 * task card.
 *
 * Covers the disambiguation contract the shared anatomy introduces:
 *   - chips are single-select: picking one deselects the others, tapping the
 *     selected chip again clears it;
 *   - picking a chip clears the free text (and the input never echoes the
 *     chip value — the two modes are visually distinct);
 *   - typing in the free text visually deselects the chips;
 *   - Enter in the free text emits `submit`;
 *   - the exposed `pickIndex` drives the 1–9 keyboard path.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

import TaskOptions from '../TaskOptions.vue';

// The placeholder copy flows through vue-i18n now; `useI18n` is a Nuxt
// auto-import, so it has to exist as a global for the component's setup.
beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

function mountOptions(props: Record<string, unknown> = {}) {
	return mount(TaskOptions, {
		props: { options: ['Yes', 'No'], modelValue: '', ...props },
		global: { plugins: [createTestI18n()] },
	});
}

const chipSel = '[data-testid="task-option-chip"]';
const inputSel = '[data-testid="task-option-input"]';

describe('TaskOptions', () => {
	it('renders numbered chips and a free-text input', () => {
		const wrapper = mountOptions();
		const chips = wrapper.findAll(chipSel);
		expect(chips).toHaveLength(2);
		expect(chips[0]!.text()).toContain('Yes');
		expect(chips[1]!.text()).toContain('No');
		// The 1–9 keyboard affordance is visible on the chips.
		expect(chips[0]!.find('kbd').text()).toBe('1');
		expect(chips[1]!.find('kbd').text()).toBe('2');
		expect(wrapper.find(inputSel).exists()).toBe(true);
		// With chips present the input is the secondary ("or type") affordance.
		expect(wrapper.find(inputSel).attributes('placeholder')).toBe('Or type an answer…');
	});

	it('falls back to the free-text placeholder when there are no chips', () => {
		const wrapper = mountOptions({ options: [] });
		expect(wrapper.find(inputSel).attributes('placeholder')).toBe('Type your answer…');
	});

	it('single-select: picking a chip deselects the others; re-tap clears it', async () => {
		const wrapper = mountOptions();
		const chips = wrapper.findAll(chipSel);

		await chips[0]!.trigger('click');
		expect(wrapper.emitted('update:modelValue')!.at(-1)).toEqual(['Yes']);
		expect(chips[0]!.attributes('aria-pressed')).toBe('true');
		expect(chips[1]!.attributes('aria-pressed')).toBe('false');

		await chips[1]!.trigger('click');
		expect(wrapper.emitted('update:modelValue')!.at(-1)).toEqual(['No']);
		expect(chips[0]!.attributes('aria-pressed')).toBe('false');
		expect(chips[1]!.attributes('aria-pressed')).toBe('true');

		// Toggle off.
		await chips[1]!.trigger('click');
		expect(wrapper.emitted('update:modelValue')!.at(-1)).toEqual(['']);
		expect(chips[1]!.attributes('aria-pressed')).toBe('false');
	});

	it('picking a chip clears the free text and does not echo into the input', async () => {
		const wrapper = mountOptions();
		await wrapper.find(inputSel).setValue('half refund');
		await wrapper.findAll(chipSel)[0]!.trigger('click');
		expect(wrapper.emitted('update:modelValue')!.at(-1)).toEqual(['Yes']);
		expect((wrapper.find(inputSel).element as HTMLInputElement).value).toBe('');
	});

	it('typing in the free text visually deselects the chips', async () => {
		const wrapper = mountOptions();
		const chips = wrapper.findAll(chipSel);
		await chips[0]!.trigger('click');
		expect(chips[0]!.attributes('aria-pressed')).toBe('true');

		await wrapper.find(inputSel).setValue('something else');
		expect(chips[0]!.attributes('aria-pressed')).toBe('false');
		expect(wrapper.emitted('update:modelValue')!.at(-1)).toEqual(['something else']);
	});

	it('emits submit on Enter in the free text', async () => {
		const wrapper = mountOptions();
		await wrapper.find(inputSel).trigger('keydown.enter');
		expect(wrapper.emitted('submit')).toBeTruthy();
	});

	it('pickIndex (the 1–9 keyboard path) picks the matching chip', async () => {
		const wrapper = mountOptions();
		(wrapper.vm as unknown as { pickIndex: (i: number) => void }).pickIndex(1);
		await wrapper.vm.$nextTick();
		expect(wrapper.emitted('update:modelValue')!.at(-1)).toEqual(['No']);
		// Out-of-range indexes are ignored.
		(wrapper.vm as unknown as { pickIndex: (i: number) => void }).pickIndex(7);
		await wrapper.vm.$nextTick();
		expect(wrapper.emitted('update:modelValue')!.at(-1)).toEqual(['No']);
	});
});
