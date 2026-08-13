/**
 * Vue I18n runtime options, picked up automatically by @nuxtjs/i18n
 * (`i18n/i18n.config.ts`).
 *
 * `fallbackLocale: 'en'` is what makes a partially translated locale safe: a key
 * that a translation file has not caught up with renders its English text
 * instead of the raw key path.
 */
export default defineI18nConfig(() => ({
	legacy: false,
	fallbackLocale: 'en',
	// A key that exists in no locale is a bug in the app, not in the translation —
	// keep it loud in dev and silent in the console a visitor might have open.
	missingWarn: import.meta.dev,
	fallbackWarn: false,
}));
