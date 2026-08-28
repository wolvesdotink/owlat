import { getOptional } from '../lib/env';
import { isDevDeployment } from '../devShortcuts/_guard';

// Desktop app (Tauri) origins. The packaged webview serves the bundled SPA from
// these origins and talks to this instance cross-origin via the cross-domain
// plugin (header-based session, no cookies). See apps/web/app/lib/auth-client.ts
// (desktop branch).
const DESKTOP_TRUSTED_ORIGINS = ['tauri://localhost', 'https://tauri.localhost'] as const;

/**
 * Resolve the trusted browser origins for BetterAuth (L10).
 *
 * In DEV (`OWLAT_DEV_MODE`) the loopback defaults stay so a local checkout works
 * with no env. In PRODUCTION the silent `http://localhost` fallback is dropped:
 * `SITE_URL` is REQUIRED (an unset one means the deployment is misconfigured and
 * would otherwise trust loopback for CSRF/redirect origin checks), and
 * `ADMIN_SITE_URL` is trusted only when actually set — never defaulted to
 * `localhost:3001`. Called at request time (see the `trustedOrigins` function),
 * so the throw fails the request closed rather than the push.
 */
export function resolveTrustedOrigins(): string[] {
	const siteUrl = getOptional('SITE_URL');
	const adminSiteUrl = getOptional('ADMIN_SITE_URL');

	if (isDevDeployment()) {
		return [
			siteUrl || 'http://localhost:3000',
			adminSiteUrl || 'http://localhost:3001',
			...DESKTOP_TRUSTED_ORIGINS,
		];
	}

	if (!siteUrl) {
		throw new Error(
			'Missing required environment variable: SITE_URL (required in production to set trusted auth origins; the localhost fallback is dev-only)'
		);
	}
	return [siteUrl, ...(adminSiteUrl ? [adminSiteUrl] : []), ...DESKTOP_TRUSTED_ORIGINS];
}
