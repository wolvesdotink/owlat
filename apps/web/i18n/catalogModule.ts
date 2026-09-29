/**
 * Writes the build's boot catalogs and area chunks (./writeCatalogs.ts) and
 * exposes the chunk manifest to the app as `#build/owlat-i18n-areas.mjs`,
 * which app/plugins/i18n-areas.client.ts loads the chunks through.
 *
 * nuxt.config lists it through `I18N_MODULES`, ahead of `@nuxtjs/i18n`, so the
 * boot catalogs exist before that module reads (and hashes) its locale files.
 */
import { addTemplate, addTypeTemplate, defineNuxtModule } from 'nuxt/kit';
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
