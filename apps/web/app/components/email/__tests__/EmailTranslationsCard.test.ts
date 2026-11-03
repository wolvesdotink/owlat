/**
 * The email settings card's "Add language" menu, against the real
 * UiDropdownMenu. That menu opens only through its `open` model, so a card that
 * does not bind it renders a button that does nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';

import EmailTranslationsCard from '../EmailTranslationsCard.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

const cardStub = { template: '<div><slot /></div>' };

let wrapper: VueWrapper | undefined;

beforeEach(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
});

afterEach(() => {
	wrapper?.unmount();
	wrapper = undefined;
});

function mountCard() {
	wrapper = mount(EmailTranslationsCard, {
		attachTo: document.body,
		props: {
			supportedLanguages: [],
			defaultLanguage: 'de',
			translations: {},
		},
		global: {
			plugins: [createTestI18n()],
			stubs: { UiCard: cardStub, UiInput: true, UiTextarea: true },
		},
	});
	return wrapper;
}

const menuItems = () => Array.from(document.body.querySelectorAll('[role="menuitem"]'));

describe('EmailTranslationsCard add-language menu', () => {
	it('opens on a click and offers every language but the default', async () => {
		const card = mountCard();

		await card.get('button').trigger('click');
		await nextTick();

		const labels = menuItems().map((item) => item.textContent?.trim());
		expect(labels).toContain('English (English)');
		expect(labels).not.toContain('German (Deutsch)');
	});

	it('asks the page to add the language picked from the menu', async () => {
		const card = mountCard();

		await card.get('button').trigger('click');
		await nextTick();
		const english = menuItems().find((item) => item.textContent?.includes('English'));
		(english as HTMLElement).click();
		await nextTick();

		expect(card.emitted('add-language')).toEqual([['en']]);
		expect(menuItems()).toHaveLength(0);
	});
});
