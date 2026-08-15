/**
 * Vue I18n runtime options, picked up automatically by @nuxtjs/i18n
 * (`i18n/i18n.config.ts`). Mirrors apps/web/i18n/i18n.config.ts so the two Nuxt
 * apps behave identically when a key is missing.
 *
 * `fallbackLocale: 'en'` is what makes a partially translated locale safe: a key
 * that a translation file has not caught up with renders its English text
 * instead of the raw key path. On a public marketing page that is the
 * difference between an untranslated sentence and a visible `hero.title`.
 */
export default defineI18nConfig(() => ({
	legacy: false,
	fallbackLocale: 'en',
	// A key that exists in no locale is a bug in the app, not in the translation —
	// keep it loud in dev and silent in the console a visitor might have open.
	missingWarn: import.meta.dev,
	fallbackWarn: false,
}));
