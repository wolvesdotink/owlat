/**
 * Writes the build's boot catalogs and area chunks (./writeCatalogs.ts) and
 * exposes the chunk manifest to the app as `#build/owlat-i18n-areas.mjs`,
 * which app/plugins/i18n-areas.client.ts loads the chunks through.
 *
 * nuxt.config lists it through `I18N_MODULES`, ahead of `@nuxtjs/i18n`, so the
 * boot catalogs exist before that module reads (and hashes) its locale files.
 */
import { addTemplate, addTypeTemplate, defineNuxtModule } from 'nuxt/kit';
import { i18nBuildLocales } from './completeCatalogs';
import { AREA_MANIFEST_TYPES, areaManifestModule, writeBuildCatalogs } from './writeCatalogs';

const catalogModule = defineNuxtModule({
	meta: { name: 'owlat-i18n-areas' },
	setup() {
		const manifest = writeBuildCatalogs();
		addTemplate({
			filename: 'owlat-i18n-areas.mjs',
			getContents: () => areaManifestModule(manifest),
		});
		addTypeTemplate({
			filename: 'types/owlat-i18n-areas.d.ts',
			getContents: () => AREA_MANIFEST_TYPES,
		});
	},
});

/** The i18n modules, in the order nuxt.config `modules` must install them. */
export const I18N_MODULES = [catalogModule, '@nuxtjs/i18n'];

/** The `@nuxtjs/i18n` options nuxt.config passes as `i18n`. */
export const I18N_OPTIONS = {
	defaultLocale: 'en',
	// `no_prefix`: the locale never appears in the URL. Every path in this app
	// is either a dashboard route or a token link printed inside an already-sent
	// email (/unsubscribe?token=…), so a locale segment would break live links
	// and would have to be mirrored in every nuxt.config `routeRules` redirect.
	strategy: 'no_prefix',
	// Message files live in i18n/locales/ (the module's `restructureDir`) and are
	// loaded on demand, one catalog per visitor: a build registers each locale's
	// boot catalog (translations completed from `en`, i18n/completeCatalogs.ts),
	// and each route area's messages load with the area (i18n/catalogAreas.ts).
	// Built from `@owlat/shared/appLocales` (see i18n/localeOptions.ts).
	locales: i18nBuildLocales(),
	// The whole UI is extracted, so a first-time visitor can safely be served
	// the locale their browser asks for. The cookie is what makes the choice
	// stick: with `no_prefix` the URL carries no locale, so without it every
	// reload would re-run detection and undo the picker
	// (components/LanguagePicker.vue) for anyone whose browser disagrees with
	// them. `owlat-locale` is read back by that picker's `setLocale`.
	detectBrowserLanguage: { useCookie: true, cookieKey: 'owlat-locale' },
} as const;
