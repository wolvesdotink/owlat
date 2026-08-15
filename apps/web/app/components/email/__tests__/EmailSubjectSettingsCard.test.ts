// @vitest-environment happy-dom
/**
 * The email settings card's default-language picker.
 *
 * `~/data/languageOptions` is module scope, so its `label` is a MESSAGE KEY;
 * the card interpolates it into `languageOption` ("{label} ({nativeLabel})")
 * and once shipped the keypath itself into the dropdown. These mounts assert
 * the resolved English name and that no catalog keypath reaches an option.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';

import EmailSubjectSettingsCard from '../EmailSubjectSettingsCard.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

const cardStub = { template: '<div><slot /></div>' };
// Rendering the option labels is the point of the stub — a `true` stub would
// swallow exactly the strings under test.
const selectStub = {
	props: ['modelValue', 'label', 'options', 'disabled', 'helpText'],
	emits: ['update:modelValue'],
	template:
		'<select :aria-label="label"><option v-for="o in options" :key="o.value" :value="o.value">{{ o.label }}</option></select>',
};
const inputStub = { props: ['modelValue', 'label'], template: '<input :aria-label="label" />' };

beforeEach(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
});

function mountCard() {
	return mount(EmailSubjectSettingsCard, {
		props: {
			published: false,
			emailType: 'marketing' as const,
			defaultLanguage: 'en',
			subject: 'Spring release',
			previewText: 'What shipped this month',
		},
		global: {
			plugins: [createTestI18n()],
			stubs: {
				UiCard: cardStub,
				UiSelect: selectStub,
				UiInput: inputStub,
				UiTextarea: inputStub,
				Icon: true,
			},
		},
	});
}

describe('EmailSubjectSettingsCard default-language picker', () => {
	it('renders translated language names, not catalog message keys', () => {
		const options = mountCard()
			.findAll('option')
			.map((o) => o.text());

		expect(options).toContain('German (Deutsch)');
		expect(options).toContain('French (Français)');
	});

	it('leaks no raw message keys into the card', () => {
		const wrapper = mountCard();
		for (const rendered of [wrapper.text(), ...wrapper.findAll('option').map((o) => o.text())]) {
			expect(rendered).not.toMatch(/shared\.data\.languageOptions\./);
		}
	});
});
