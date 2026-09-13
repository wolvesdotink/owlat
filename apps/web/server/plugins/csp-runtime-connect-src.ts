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
		const origins = [
			publicConfig['convexUrl'] as string | undefined,
			publicConfig['convexSiteUrl'] as string | undefined,
			publicConfig['posthogHost'] as string | undefined,
		].filter((url): url is string => typeof url === 'string' && url.length > 0);

		if (origins.length === 0) return;

		const sources = origins.flatMap((url) => [url, url.replace(/^http/, 'ws')]);

		// `upgrade-insecure-requests` rewrites this deployment's OWN ws:// backend
		// to wss:// before the request leaves the browser. Where the operator
		// reaches Convex over plaintext (an IP or a bare host with no TLS in
		// front) there is nothing listening on the upgraded scheme, so the sync
		// socket never opens and the app sits on empty data with no error a user
		// could act on. An http backend is already unencrypted; forcing the
		// upgrade does not make it private, it only breaks it. Deployments on
		// https keep the directive.
		const plaintextBackend = origins.some((url) => url.startsWith('http://'));

		for (const rule of Object.values(rules)) {
			const csp = (rule as { headers?: { contentSecurityPolicy?: Record<string, unknown> } })
				?.headers?.contentSecurityPolicy;
			const connectSrc = csp?.['connect-src'];
			if (!Array.isArray(connectSrc)) continue;
			csp['connect-src'] = [...new Set([...(connectSrc as string[]), ...sources])];
			if (plaintextBackend && csp['upgrade-insecure-requests'] !== undefined) {
				csp['upgrade-insecure-requests'] = false;
			}
		}
	});
});
