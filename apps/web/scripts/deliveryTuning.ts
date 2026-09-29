/**
 * How the built app is delivered: asset precompression and route prefetching.
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
