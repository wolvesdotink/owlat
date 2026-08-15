// @vitest-environment happy-dom
/**
 * THE LANGUAGE PICKER.
 *
 * This is the only control in the app that changes the locale, so the two ways
 * it can quietly stop working are both failures a user meets head-on: a locale
 * registered in `nuxt.config` that never appears as a choice (the picker
 * hardcoded its list instead of reading the module's), and a click that paints
 * a selection without calling `setLocale` — which is what writes the
 * `owlat-locale` cookie, and therefore the difference between switching the
 * language and switching it until the next page load.
 *
 * The locale list is read out of the REAL `nuxt.config.ts` rather than restated
 * here: a test with its own copy of the list would keep passing on the day the
 * two disagree, which is the day the picker starts hiding a shipped language.
 */
import { describe, expect, it, beforeAll, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { computed } from 'vue';
import { createI18n, useI18n as useVueI18n } from 'vue-i18n';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expectFullyLocalized } from '~/__tests__/i18n';
import en from '~~/i18n/locales/en.json';
import de from '~~/i18n/locales/de.json';
import LanguagePicker from '../LanguagePicker.vue';
import PreferencesLanguage from '../preferences/PreferencesLanguage.vue';

/** The `locales:` entries the i18n module is actually configured with. */
function configuredLocales(): Array<{ code: string; language: string; name: string }> {
	const config = readFileSync(join(import.meta.dirname, '../../../nuxt.config.ts'), 'utf8');
	const entries = [
		...config.matchAll(
			/\{ code: '(?<code>[^']+)', language: '(?<language>[^']+)', name: '(?<name>[^']+)'/g
		),
	].map((match) => match.groups as unknown as { code: string; language: string; name: string });
	// A regex that stopped matching would turn every assertion below into a
	// no-op over an empty list.
	expect(entries.length).toBeGreaterThan(1);
	return entries;
}

const locales = configuredLocales();
const setLocale = vi.fn(async () => {});

/**
 * `useI18n()` in the app is the module-extended composer, so the stub is the
 * real vue-i18n one with the module's additions layered on top of it —
 * prototype-chained rather than spread, so `t` and `locale` stay the live
 * composer's own reactive members.
 */
function useI18nStub() {
	const composer = useVueI18n();
	return Object.create(composer, {
		locales: { value: computed(() => locales) },
		setLocale: { value: setLocale },
	}) as ReturnType<typeof useVueI18n>;
}

beforeAll(() => {
	Object.assign(globalThis, { useI18n: useI18nStub, computed });
});

beforeEach(() => {
	vi.clearAllMocks();
});

/** `createI18n` is typed against the module's registered codes, not `string`. */
function mountPicker(component: unknown, locale: 'en' | 'de' = 'en') {
	return mount(component as never, {
		global: {
			plugins: [createI18n({ legacy: false, locale, fallbackLocale: 'en', messages: { en, de } })],
			// `LanguagePicker` is an auto-import in the app; PreferencesLanguage
			// renders it by that name.
			components: { LanguagePicker },
			stubs: { Icon: { template: '<span />' } },
		},
	});
}

describe('LanguagePicker', () => {
	it('offers every locale the i18n module is configured with', () => {
		const w = mountPicker(LanguagePicker);
		const buttons = w.findAll('button');

		expect(buttons).toHaveLength(locales.length);
		for (const [index, entry] of locales.entries()) {
			// The name is written in its own language, and marked as such so a
			// screen reader does not read "Deutsch" with an English voice.
			expect(buttons[index]!.text()).toContain(entry.name);
			expect(buttons[index]!.get(`[lang="${entry.language}"]`).text()).toBe(entry.name);
		}
		expectFullyLocalized(w);
	});

	it('names the group from the catalog and marks the active locale pressed', () => {
		const w = mountPicker(LanguagePicker, 'de');

		expect(w.get('[role="group"]').attributes('aria-label')).toBe('Sprache der Oberfläche');
		const pressed = w.findAll('[aria-pressed="true"]');
		expect(pressed).toHaveLength(1);
		expect(pressed[0]!.text()).toContain('Deutsch');
		expectFullyLocalized(w);
	});

	it('switches through setLocale, which is what persists the choice', async () => {
		const w = mountPicker(LanguagePicker);
		const target = locales.find((entry) => entry.code !== 'en')!;

		await w.findAll('button')[locales.indexOf(target)]!.trigger('click');

		expect(setLocale).toHaveBeenCalledWith(target.code);
	});

	it('ignores a click on the locale already active', async () => {
		const w = mountPicker(LanguagePicker);

		await w.get('[aria-pressed="true"]').trigger('click');

		expect(setLocale).not.toHaveBeenCalled();
	});
});

describe('PreferencesLanguage', () => {
	it('frames the picker with copy from the catalog', () => {
		const w = mountPicker(PreferencesLanguage);

		expect(w.text()).toContain('Language');
		expect(w.text()).toContain("Choose the language Owlat's interface is shown in on this device.");
		expect(w.text()).toContain('Remembered in this browser.');
		expect(w.findAllComponents(LanguagePicker)).toHaveLength(1);
		expectFullyLocalized(w);
	});
});
