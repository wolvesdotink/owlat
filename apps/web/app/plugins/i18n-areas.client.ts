import { areaChunks, areaRoutes, messageRoots } from '#build/owlat-i18n-areas.mjs';
import { createAreaCatalogs, type AreaMessages } from '~~/i18n/areaRuntime';

/**
 * Load a route area's messages before the route renders.
 *
 * A build ships each locale's catalog as a boot catalog plus one chunk per
 * route area (i18n/catalogAreas.ts), so the sign-in page no longer downloads
 * the admin console's copy. This plugin is what keeps that invisible: the
 * chunk download starts with the navigation, the navigation waits for it in
 * `beforeResolve` (after every middleware and redirect), a language switch
 * merges every area already in use in the new language before it lands, and a
 * key the loaded catalogs still lack renders as nothing while the remaining
 * chunks load, never as its key path.
 *
 * The dev server registers the source catalogs whole and has no chunks, so
 * there this does nothing.
 */
export default defineNuxtPlugin({
	name: 'owlat:i18n-areas',
	dependsOn: ['i18n:plugin'],
	setup(nuxtApp) {
		if (areaRoutes.length === 0) return;
		const i18n = nuxtApp.$i18n as unknown as {
			locale: { value: string };
			mergeLocaleMessage: (locale: string, messages: AreaMessages) => void;
			setMissingHandler: (handler: (locale: string, key: string) => string | undefined) => void;
		};
		const catalogs = createAreaCatalogs({
			routes: areaRoutes,
			chunks: areaChunks,
			roots: messageRoots,
			merge: (locale, messages) => i18n.mergeLocaleMessage(locale, messages),
			locale: () => i18n.locale.value,
			onError: (error) => console.error('[i18n] Could not load a message chunk', error),
		});
		const router = useRouter();
		router.beforeEach((to) => catalogs.prefetch(to.path));
		router.beforeResolve((to) => catalogs.ensure(to.path));
		nuxtApp.hook('i18n:beforeLocaleSwitch', ({ newLocale }) => catalogs.switchLocale(newLocale));
		i18n.setMissingHandler((locale, key) => catalogs.missing(locale, key));
	},
});
