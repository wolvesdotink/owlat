// @vitest-environment happy-dom
/**
 * AiKeyField — a password input for a provider API key plus the masked
 * "saved key" hint.
 *
 * Covers the two state-driven bits of render behaviour: the placeholder swaps
 * on `storedKeySet`, and the masked `keyPreview` hint shows only once a key is
 * both stored and previewable.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

import AiKeyField from '../AiKeyField.vue';

// The placeholders and the saved-key hint flow through vue-i18n now; `useI18n`
// is a Nuxt auto-import, so it has to exist as a global for the component setup.
beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

// UiInput is a Nuxt UI auto-import; stub it so the driving props reach the DOM.
const UiInputStub = {
	props: ['modelValue', 'type', 'label', 'placeholder', 'error', 'disabled', 'helpText'],
	emits: ['update:modelValue'],
	template: '<input data-testid="ui-input" :placeholder="placeholder" />',
};

function mountField(props: Record<string, unknown> = {}) {
	return mount(AiKeyField, {
		props: { label: 'API key', storedKeySet: false, modelValue: '', ...props },
		global: { plugins: [createTestI18n()], stubs: { UiInput: UiInputStub, Icon: true } },
	});
}

const previewSel = 'p';
const inputSel = '[data-testid="ui-input"]';

describe('AiKeyField', () => {
	it('prompts to paste a key when none is stored, and hides the saved-key hint', () => {
		const wrapper = mountField({ storedKeySet: false, keyPreview: 'sk-…a1b2' });
		expect(wrapper.find(inputSel).attributes('placeholder')).toBe('Paste your API key');
		// No stored key ⇒ no masked hint, even if a stray preview is passed.
		expect(wrapper.text()).not.toContain('Saved key');
	});

	it('swaps the placeholder and renders the masked preview once a key is stored', () => {
		const wrapper = mountField({ storedKeySet: true, keyPreview: 'sk-…a1b2' });
		expect(wrapper.find(inputSel).attributes('placeholder')).toBe(
			'Leave blank to keep the saved key'
		);
		const hint = wrapper.findAll(previewSel).find((p) => p.text().includes('Saved key'));
		expect(hint?.text()).toContain('sk-…a1b2');
	});

	it('omits the masked hint when a key is stored but no preview is available', () => {
		const wrapper = mountField({ storedKeySet: true, keyPreview: undefined });
		expect(wrapper.text()).not.toContain('Saved key');
	});
});
