/**
 * Build the absolute URL of the internal Convex-token exchange endpoint
 * (`/api/auth/convex/token`) from the instance's TRUSTED configured origin.
 *
 * SECURITY: this URL must NOT be derived from request-controlled input such as
 * the `Host` header. `requirePlatformAdmin` forwards the caller's session
 * cookie to this URL, so a spoofed `Host` would let an attacker redirect that
 * cookie to an origin of their choosing (a low-value SSRF / credential leak).
 * We always build it from `runtimeConfig.public.siteUrl`, which is operator
 * configuration, never client input.
 *
 * @param siteUrl The instance's configured web origin (e.g. `https://acme.owlat.app`).
 */
export function buildInternalTokenUrl(siteUrl: string): string {
	// `new URL(path, base)` resolves the absolute endpoint and normalises any
	// trailing slash on `siteUrl`, throwing on a malformed base.
	return new URL('/api/auth/convex/token', siteUrl).toString();
}
