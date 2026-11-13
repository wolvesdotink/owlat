/**
 * Route warm-up: for the URL the app opens on, start downloading what the first
 * navigation will wait for, so those requests overlap the boot catalog and the
 * session check instead of following them one by one.
 *
 * `nuxt:router` resolves the initial route's components before any app plugin
 * runs, but the route only renders after a second navigation in `app:created`,
 * once every plugin (the blocking i18n one included) is done. That navigation
 * fetches each named middleware chunk as it reaches it, the `auth` one waits
 * for the session, `i18n-areas` asks for the area catalog after the middleware,
 * and the layout chunk is requested only once `NuxtLayout` renders. Everything
 * here is known from the URL alone, so it starts now and nothing is awaited.
 * Each call is the same loader the navigation makes later, which then finds the
 * module in flight or loaded.
 *
 * A Postbox URL that names a message also starts the thread reader: the folder
 * page mounts it lazily, so on a deep link its code would otherwise start only
 * after the page chunk has downloaded and run.
 *
 * i18n has not picked a locale yet, so the area catalog is fetched in the
 * locale it will most likely pick (`guessLocale`); a wrong guess costs one
 * unused chunk, never wrong copy.
 *
 * Skipped where the auth warm-up skips: public pages and setup mode (a
 * redirect or no layout is the likely next step), and the desktop runtime,
 * whose workspace boot plugin may still switch the workspace before the first
 * navigation and whose chunks are local files.
 */
import layouts from '#build/layouts';
import { namedMiddleware } from '#build/middleware';
import { areaChunks, areaRoutes } from '#build/owlat-i18n-areas.mjs';
import { areasForPath, guessLocale, type AreaChunks } from '~~/i18n/areaRuntime';
import { warmPostboxThreadReader } from '~/composables/postbox/usePostboxChunkWarmup';
import { isDesktopRuntime } from '~/lib/desktop/activeWorkspace';
import { isPublicRoute } from '~/utils/publicRoutes';

type Layouts = Record<string, { __asyncLoader?: () => Promise<unknown> } | undefined>;
type NamedMiddleware = Record<string, (() => Promise<unknown>) | undefined>;

/** The navigation asks again and handles its own failure. */
const ignore = () => {};

export default defineNuxtPlugin({
	name: 'owlat:route-warmup',
	enforce: 'pre',
	parallel: true,
	setup() {
		if (isDesktopRuntime()) return;
		if (useRuntimeConfig().public.setupMode || isPublicRoute()) return;

		const route = useRouter().currentRoute.value;
		void preloadRouteComponents(route.fullPath).catch(ignore);
		const messageId = route.params.messageId;
		if (
			route.path.startsWith('/dashboard/postbox/') &&
			typeof messageId === 'string' &&
			messageId
		) {
			void warmPostboxThreadReader();
		}

		const layout = route.meta.layout;
		if (typeof layout === 'string') {
			(layouts as Layouts)[layout]?.__asyncLoader?.().catch(ignore);
		}

		const middleware = new Set(
			route.matched.flatMap((record) => [record.meta.middleware ?? []].flat())
		);
		for (const name of middleware) {
			if (typeof name === 'string') (namedMiddleware as NamedMiddleware)[name]?.().catch(ignore);
		}

		const areas = areasForPath(areaRoutes, route.path);
		if (areas.length === 0) return;
		const chunks: AreaChunks = areaChunks;
		const locales = [...new Set(Object.values(chunks).flatMap((chunk) => Object.keys(chunk)))];
		const locale = guessLocale(document.cookie, navigator.languages, locales, 'en');
		for (const area of areas) chunks[area]?.[locale]?.().catch(ignore);
	},
});
