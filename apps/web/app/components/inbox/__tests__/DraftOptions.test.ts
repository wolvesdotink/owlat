// @vitest-environment happy-dom
/**
 * DraftOptions review-gate selector:
 *   - renders one radio per offered draft option (concise / hedged / detailed)
 *   - marks the bound modelValue index as selected
 *   - picking a different option emits `update:modelValue` with its index
 *     (one-tap selection — the parent then approves whichever is selected)
 *
 * `computed` is polyfilled by the web vitest setup (Nuxt auto-imports); <Icon>
 * is a global auto-import, stubbed here.
 */
import { beforeAll, describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';

import DraftOptions from '../DraftOptions.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

// Every visible string flows through vue-i18n now: mount with the real catalog
// and expose `useI18n`, which is a Nuxt auto-import in the app.
beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

const mountOpts = {
	global: { plugins: [createTestI18n()], stubs: { Icon: true } },
};
const OPTIONS = ['Concise reply.', 'Hedged reply.', 'Detailed reply.'];

describe('DraftOptions', () => {
	it('renders one radio per option and marks the bound index selected', () => {
		const wrapper = mount(DraftOptions, {
			...mountOpts,
			props: { options: OPTIONS, modelValue: 0 },
		});

		const radios = wrapper.findAll('input[type="radio"]');
		expect(radios).toHaveLength(3);
		expect(wrapper.text()).toContain('Concise reply.');
		expect(wrapper.text()).toContain('Detailed reply.');
		// Default: option 0 is selected.
		expect((radios[0]!.element as HTMLInputElement).checked).toBe(true);
		expect((radios[1]!.element as HTMLInputElement).checked).toBe(false);
	});

	it('emits update:modelValue with the picked index (one-tap select)', async () => {
		const wrapper = mount(DraftOptions, {
			...mountOpts,
			props: { options: OPTIONS, modelValue: 0 },
		});

		await wrapper.findAll('input[type="radio"]')[2]!.trigger('change');

		const emitted = wrapper.emitted('update:modelValue');
		expect(emitted).toBeTruthy();
		expect(emitted![0]).toEqual([2]);
	});

	it('reflects a non-zero bound selection', () => {
		const wrapper = mount(DraftOptions, {
			...mountOpts,
			props: { options: OPTIONS, modelValue: 1 },
		});
		const radios = wrapper.findAll('input[type="radio"]');
		expect((radios[1]!.element as HTMLInputElement).checked).toBe(true);
		expect((radios[0]!.element as HTMLInputElement).checked).toBe(false);
	});
});
