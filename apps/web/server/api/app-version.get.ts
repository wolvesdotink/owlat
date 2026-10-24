/**
 * The build this server serves, for open tabs to compare with their own.
 *
 * `buildId` is Nuxt's id for the client bundle this server renders into every
 * document; a tab booted from another one runs code the server no longer
 * serves (`app/lib/appVersion.ts`). `version` is the image's release version
 * (read at startup, see `owlatVersion` in nuxt.config.ts), so the tab can name
 * the release and link its notes.
 *
 * Unauthenticated, like the build manifest under `/_nuxt/builds/`: both values
 * already ship in the public bundle. Never cached, or a tab would compare
 * against an answer from before the deploy.
 */
export default defineEventHandler((event) => {
	const config = useRuntimeConfig(event);
	setHeader(event, 'cache-control', 'no-store');
	return {
		buildId: String(config.app.buildId ?? ''),
		version: String(config.public.owlatVersion ?? ''),
	};
});
