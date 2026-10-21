import { createI18n } from 'vue-i18n';

/**
 * The host app's vue-i18n, as the builder meets it in apps/web: the builder's
 * messages are NOT in it (they ship with the package), only the active locale
 * is read from it. A fresh instance per mount, so locale state cannot leak.
 */
export function createHostI18n(locale: 'en' | 'de' | 'de-DE' | 'fr' = 'en') {
	return createI18n({
		legacy: false,
		locale,
		fallbackLocale: 'en',
		missingWarn: false,
		fallbackWarn: false,
		messages: { en: { app: { unrelated: 'unrelated' } }, de: {} },
	});
}
