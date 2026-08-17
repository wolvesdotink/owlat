// @vitest-environment happy-dom
/**
 * The test-send modal's language picker.
 *
 * `~/data/languageOptions` is module scope, so its `label` is a MESSAGE KEY.
 * The picker once rendered that key verbatim — "shared.data.languageOptions.
 * languages.de (Deutsch)" in a dropdown and, worse, inside the "Default (…)"
 * sentence. These mounts assert the resolved English name instead, and that no
 * catalog keypath survives anywhere in the rendered modal.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';

import TestEmailModal from '../TestEmailModal.vue';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';

const modalStub = {
	props: ['open', 'title', 'persistent'],
	emits: ['update:open'],
	template: '<div v-if="open"><slot /><div class="footer"><slot name="footer" /></div></div>',
};
const modalFooterStub = { template: '<div><slot /></div>' };
const buttonStub = {
	props: ['loading', 'disabled', 'variant'],
	emits: ['click'],
	template: '<button :disabled="disabled"><slot /></button>',
};

beforeEach(() => {
	// `useI18n` is a Nuxt auto-import; the real one resolves against the instance
	// `global.plugins` installs.
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useConvex', () => null);
});

function mountModal() {
	return mount(TestEmailModal, {
		props: {
			open: true,
			campaignId: null,
			subject: 'Spring release',
			fromName: 'Ada',
			fromEmail: 'ada@example.com',
			// More than one language is what reveals the picker at all.
			languages: ['en', 'de'],
			defaultLanguage: 'de',
		},
		global: {
			plugins: [createTestI18n()],
			stubs: {
				UiModal: modalStub,
				UiModalFooter: modalFooterStub,
				UiButton: buttonStub,
				Icon: true,
			},
		},
	});
}

describe('TestEmailModal language picker', () => {
	it('renders translated language names, not catalog message keys', () => {
		const wrapper = mountModal();
		const options = wrapper.findAll('option').map((o) => o.text());

		// English's endonym IS its English name, so it is not parenthesized.
		expect(options).toContain('English');
		expect(options).toContain('German (Deutsch)');
		// The default option interpolates the same label into a sentence.
		expect(options).toContain('Default (German (Deutsch))');
	});

	it('leaks no raw message keys into the modal', () => {
		const wrapper = mountModal();
		for (const rendered of [wrapper.text(), ...wrapper.findAll('option').map((o) => o.text())]) {
			expect(rendered).not.toMatch(/shared\.data\.languageOptions\./);
		}
		expectFullyLocalized(wrapper);
	});
});
