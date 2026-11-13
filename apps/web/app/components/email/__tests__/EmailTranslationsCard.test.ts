/**
 * The email settings card's "Add language" menu, against the real
 * UiDropdownMenu. That menu opens only through its `open` model, so a card that
 * does not bind it renders a button that does nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';

import EmailTranslationsCard from '../EmailTranslationsCard.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

const cardStub = { template: '<div><slot /></div>' };

let wrapper: VueWrapper | undefined;

// What the remove-language confirmation answers.
let confirmAnswer = true;
const confirmSpy = vi.fn(async () => confirmAnswer);

beforeEach(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	confirmAnswer = true;
	confirmSpy.mockClear();
	vi.stubGlobal('useConfirm', () => confirmSpy);
});

afterEach(() => {
	wrapper?.unmount();
	wrapper = undefined;
});

function mountCard(supportedLanguages: string[] = []) {
	wrapper = mount(EmailTranslationsCard, {
		attachTo: document.body,
		props: {
			supportedLanguages,
			defaultLanguage: 'de',
			translations: Object.fromEntries(
				supportedLanguages.map((code) => [code, { subject: '', previewText: '' }])
			),
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

describe('EmailTranslationsCard language pills', () => {
	it('selects a language through a real button that reports its state', async () => {
		const card = mountCard(['en']);
		const pill = card.get('button[aria-pressed]');

		expect(pill.attributes('aria-pressed')).toBe('false');
		await pill.trigger('click');

		expect(card.get('button[aria-pressed]').attributes('aria-pressed')).toBe('true');
		expect(card.find('h3').text()).toContain('English');
	});

	it('removes a language only after the confirmation says yes', async () => {
		const card = mountCard(['en']);
		const remove = () => card.get('button[aria-label^="Remove"]');

		confirmAnswer = false;
		await remove().trigger('click');
		await flushPromises();
		expect(confirmSpy).toHaveBeenCalledTimes(1);
		expect(card.emitted('remove-language')).toBeUndefined();

		confirmAnswer = true;
		await remove().trigger('click');
		await flushPromises();
		expect(card.emitted('remove-language')).toEqual([['en']]);
	});
});
