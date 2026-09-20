import { defineNitroPlugin, useRuntimeConfig } from 'nitropack/runtime';

/**
 * Widen `connect-src` to the deployment's OWN backend, at runtime.
 *
 * `nuxt.config.ts` builds the directive from `process.env` — which is read when
 * the image is BUILT, not when it runs. `_server-build.yml` passes only version
 * metadata, so every published web image carries a `connect-src` that names the
 * PostHog host and nothing else: a self-hoster's Convex URL is missing, and the
 * browser blocks the very websocket the app exists to open. The build-time value
 * is still right for a from-source build (`bun run build` with the .env loaded),
 * so this widens rather than replaces it.
 *
 * `nuxt-security:routeRules` is the module's own extension point, fired from its
 * 00-routeRules plugin once the security options are assembled and before any
 * request is served (runtime/nitro/plugins/00-routeRules.js).
 *
 * Both schemes are added for each URL: Convex talks WebSocket, and a browser
 * that does not apply the CSP3 http→ws match would otherwise refuse it.
 */
export default defineNitroPlugin((nitroApp) => {
	nitroApp.hooks.hook('nuxt-security:routeRules', (rules: Record<string, unknown>) => {
		const { public: publicConfig } = useRuntimeConfig();
		// `generate:desktop` prerenders with no instance to point at — the webview
		// picks its workspace at runtime and tauri.conf.json is its real CSP
		// boundary — so there is nothing here to widen.
		if (publicConfig['isDesktopBuild'] === true) return;

		const asUrl = (value: unknown): string | undefined =>
			typeof value === 'string' && value.length > 0 ? value : undefined;

		const backends = [
			asUrl(publicConfig['convexUrl']),
			asUrl(publicConfig['convexSiteUrl']),
		].filter((url): url is string => url !== undefined);
		const origins = [...backends, asUrl(publicConfig['posthogHost'])].filter(
			(url): url is string => url !== undefined
		);

		if (origins.length === 0) return;

		const sources = origins.flatMap((url) => [url, url.replace(/^http/, 'ws')]);

		// `upgrade-insecure-requests` rewrites this deployment's OWN plaintext URLs
		// before the request leaves the browser. Where the operator runs without
		// TLS (an IP, or a bare host with nothing in front) there is nothing
		// listening on the upgraded scheme: the Convex socket never opens, and on
		// an http-served site even the shell's own /_nuxt chunks are upgraded.
		// Plaintext is already unencrypted; forcing the upgrade does not make it
		// private, it only breaks it. Anything served over https keeps the
		// directive.
		//
		// Only this deployment's own URLs count. A third-party analytics host on
		// http is not a reason to drop the directive for the whole site.
		const plaintext = [...backends, asUrl(publicConfig['siteUrl'])].some((url) =>
			url?.startsWith('http://')
		);

		for (const rule of Object.values(rules)) {
			const csp = (rule as { headers?: { contentSecurityPolicy?: Record<string, unknown> } })
				?.headers?.contentSecurityPolicy;
			const connectSrc = csp?.['connect-src'];
			if (!Array.isArray(connectSrc)) continue;
			csp['connect-src'] = [...new Set([...(connectSrc as string[]), ...sources])];
			if (plaintext && csp['upgrade-insecure-requests'] !== undefined) {
				csp['upgrade-insecure-requests'] = false;
			}
		}
	});
});
