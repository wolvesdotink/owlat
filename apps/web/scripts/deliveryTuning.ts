/**
 * How the built app is delivered: asset precompression, route prefetching and
 * web fonts.
 * Kept out of nuxt.config.ts, which is near the file-size cap.
 */

/**
 * `nitro.compressPublicAssets`: emit a `.gz` and a `.br` next to every public
 * asset at build time, and have Nitro serve them to clients that accept those
 * encodings. Without it Nitro serves `/_nuxt/*` uncompressed, which is fine
 * behind the example Caddyfile (`encode gzip zstd`) but not for a deployment
 * that exposes the Node server directly or fronts it with a proxy that does not
 * compress. Brotli is precomputed at max quality, so it beats on-the-fly gzip.
 *
 * Off for the desktop bundle (`generate:desktop`): Tauri serves `.output/public`
 * from its own scheme handler, never negotiates Content-Encoding, and would just
 * ship every file three times.
 */
export function publicAssetCompression(isDesktopBuild: boolean) {
	return isDesktopBuild ? false : { gzip: true, brotli: true };
}

/**
 * `experimental.defaults.nuxtLink`: prefetch a route's chunks when the pointer
 * enters (or keyboard focus reaches) its link, not when the link scrolls into
 * view. Nuxt's default (`visibility`) fetched every page chunk behind every
 * visible link once the app went idle, which on the sidebar alone is dozens of
 * chunks that compete with the first Convex queries on a slow link. Hover and
 * focus still start the fetch a few hundred milliseconds before the click.
 */
export const NUXT_LINK_DEFAULTS = {
	prefetchOn: { visibility: false, interaction: true },
} as const;

/**
 * `fonts` (@nuxt/fonts). Figtree needs the variable wght axis: the design
 * system's weight-based emphasis uses intermediate instances (450/550) that a
 * static 400/500/600/700 subset would snap to the nearest hundred.
 *
 * No font preloads. nuxt-security hashes `/_fonts` while @nuxt/fonts has only
 * written empty placeholders (the bytes are downloaded after prerendering), so
 * a preload carries the hash of an empty file. Google and Bunny faces have a
 * unicode-range and are never preloaded; when both are unreachable the
 * fallback providers serve faces without one, and the desktop SPA ships
 * preloads that fail their integrity check.
 */
export const FONT_OPTIONS = {
	families: [{ name: 'Figtree', weights: ['300 900'] }],
	defaults: { preload: false },
};
