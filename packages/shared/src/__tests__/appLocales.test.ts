import { describe, expect, it } from 'vitest';
import { APP_LOCALE_BCP47, APP_LOCALES, isAppLocale } from '../appLocales';

describe('appLocales', () => {
	it('ships English first, the fallback every consumer defaults to', () => {
		expect(APP_LOCALES[0]).toBe('en');
	});

	it('recognises exactly the shipped codes', () => {
		for (const locale of APP_LOCALES) expect(isAppLocale(locale)).toBe(true);
		for (const other of ['fr', '', 'EN', 'de-DE', undefined, null, 1]) {
			expect(isAppLocale(other)).toBe(false);
		}
	});

	it('maps each shipped code to a region-qualified BCP-47 tag', () => {
		expect(Object.keys(APP_LOCALE_BCP47).sort()).toEqual([...APP_LOCALES].sort());
		expect(APP_LOCALE_BCP47).toEqual({ en: 'en-US', de: 'de-DE' });
		for (const locale of APP_LOCALES) {
			expect(APP_LOCALE_BCP47[locale].startsWith(`${locale}-`)).toBe(true);
		}
	});
});
