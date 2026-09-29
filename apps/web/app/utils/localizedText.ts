/**
 * THE ONE SHAPE FOR COPY A PURE MODULE HANDS TO ITS RENDERER, AND THE ONE WAY
 * TO TURN IT INTO WORDS.
 *
 * Registries, vocabularies and rule modules are module-scope code with no
 * locale, so they cannot call `t()`. They carry a catalog key instead, bare or
 * with the values it interpolates, and whoever renders them resolves it. That
 * union used to be restated in some thirty files under as many names, and the
 * resolver pasted into sixty; two of the copies had already drifted apart on
 * what an already-worded string does.
 *
 * Domain modules may keep a name of their own (`export type BriefText =
 * LocalizedText`), but not a copy of the shape; `scripts/check-localized-text.sh`
 * enforces that.
 */

/** A catalog key, a key with the values it interpolates, or a string that is already words. */
export type LocalizedText = string | { key: string; params?: Record<string, unknown> };

/** The two vue-i18n functions the resolver needs; `useI18n()` returns both. */
export interface LocalizedTextI18n {
	t(key: string, named?: Record<string, unknown>): string;
	te(key: string, locale?: string): boolean;
}

/**
 * Render `value` as words.
 *
 * - `null` / `undefined` is the empty string, so an optional field renders as nothing.
 * - A string that is a catalog key, in the active locale or in English, is
 *   translated. The English check matters on the dev server: a key a
 *   translation has not caught up with still resolves, through vue-i18n's
 *   `fallbackLocale: 'en'`, to its English text rather than to the key path.
 *   (A build fills those gaps into the catalog itself; see
 *   i18n/completeCatalogs.ts.)
 * - Any other string is already words (a model id, a vendor name, a sentence
 *   the backend composed) and is returned unchanged, without the missing-key
 *   warning `t()` would log for it.
 * - An object is always its key translated with its params.
 */
export function resolveLocalized(
	i18n: LocalizedTextI18n,
	value: LocalizedText | null | undefined
): string {
	if (value === null || value === undefined) return '';
	if (typeof value === 'string') {
		return i18n.te(value) || i18n.te(value, 'en') ? i18n.t(value) : value;
	}
	return i18n.t(value.key, value.params ?? {});
}
