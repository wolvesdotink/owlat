/**
 * Complete translation catalogs, generated at build time.
 *
 * With `fallbackLocale: 'en'`, @nuxtjs/i18n loads a German visitor's catalogs
 * as a chain: all of `en` first, then `de`, one after the other, and vue-i18n
 * then deep-merges ~11k keys. Every key in `de.json` already has a translation
 * (the catalog tests enforce it), so all that work buys is a safety net.
 *
 * A production build therefore registers, for every locale except the source
 * one, a generated catalog with each key the translation lacks filled in from
 * `en`, and `i18n.config.ts` turns the runtime fallback off. A German visitor
 * downloads one catalog and a key a translation has not caught up with still
 * reads as English rather than as its key path. English never lands in
 * `de.json` itself: the fill happens in the build output only.
 *
 * The completed catalogs are then split into a boot catalog and route-area
 * chunks (./catalogAreas.ts, written by ./writeCatalogs.ts); the boot catalogs
 * are what `i18nBuildLocales` registers.
 *
 * The dev server keeps the plain files and the runtime fallback, so editing a
 * catalog hot-reloads and a missing key still warns in the console.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { I18N_LOCALES } from './localeOptions';

export type MessageCatalog = { [key: string]: string | MessageCatalog };

export const SOURCE_LOCALE = 'en';
// Resolved from the module's own path rather than `new URL(…, import.meta.url)`,
// which a happy-dom test environment's `URL` does not resolve to a `file:` URL.
const I18N_DIR = dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = join(I18N_DIR, 'locales');
// Under node_modules so it is ignored everywhere a build artefact must be, and
// outside `.nuxt/`, which `nuxt build` clears after the modules have run.
export const OUTPUT_DIR = join(I18N_DIR, '../node_modules/.cache/owlat-i18n');
/** Where a locale's boot catalog is written. */
export const bootCatalogPath = (file: string) => join(OUTPUT_DIR, 'boot', file);

/** `nuxt dev` sets NODE_ENV before it loads the config; build, generate and prepare do not. */
export const USES_COMPLETE_CATALOGS = process.env['NODE_ENV'] !== 'development';

function isCatalog(value: unknown): value is MessageCatalog {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `translation` with every message it lacks taken from `source`. Its own
 * messages always win, including ones `source` does not have.
 */
export function completeCatalog(
	translation: MessageCatalog,
	source: MessageCatalog
): MessageCatalog {
	const complete: MessageCatalog = {};
	for (const [key, fallback] of Object.entries(source)) {
		const own = Object.hasOwn(translation, key) ? translation[key] : undefined;
		complete[key] =
			own === undefined
				? fallback
				: isCatalog(own) && isCatalog(fallback)
					? completeCatalog(own, fallback)
					: own;
	}
	for (const [key, own] of Object.entries(translation)) {
		if (!Object.hasOwn(complete, key)) complete[key] = own;
	}
	return complete;
}

const readCatalog = (path: string): MessageCatalog => JSON.parse(readFileSync(path, 'utf-8'));

/** The `i18n.locales` entries to register: the plain files in dev, the boot catalogs otherwise. */
export function i18nBuildLocales() {
	if (!USES_COMPLETE_CATALOGS) return I18N_LOCALES;
	return I18N_LOCALES.map((locale) => ({ ...locale, file: bootCatalogPath(locale.file) }));
}

/** Every shipped locale's catalog, each translation completed from `en`. */
export function completeCatalogs(): Map<string, MessageCatalog> {
	const sourceFile = I18N_LOCALES.find((locale) => locale.code === SOURCE_LOCALE)!.file;
	const source = readCatalog(join(LOCALES_DIR, sourceFile));
	return new Map(
		I18N_LOCALES.map((locale) => [
			locale.code,
			locale.code === SOURCE_LOCALE
				? source
				: completeCatalog(readCatalog(join(LOCALES_DIR, locale.file)), source),
		])
	);
}
