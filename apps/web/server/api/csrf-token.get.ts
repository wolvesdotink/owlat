/**
 * A live CSRF token for a tab whose baked-in one no longer verifies.
 *
 * nuxt-csurf pairs an httpOnly `__Host-csrf` cookie with a token rendered into
 * the document `<head>`, and the token is the cookie value encrypted under a
 * secret the module GENERATES AT BUILD TIME. Two consequences on an `ssr:false`
 * SPA that a long-lived admin tab runs straight into:
 *
 *   - every release image carries a different secret, so the moment an in-app
 *     update promotes a new `web` image, every open tab's token stops
 *     verifying, and
 *   - the tab renders exactly one HTML document, so nothing ever re-mints the
 *     token in its `<head>`.
 *
 * The result was a bare 403 on every POST the tab made afterwards — "Apply &
 * restart", the setup wizard, delivery config — reported by each caller as its
 * own kind of failure ("Could not reach the updater", and the host-CLI fallback
 * copy that goes with it). `~/lib/csrfFetch` calls this route when it sees that
 * 403 and retries once, so the tab heals itself instead.
 *
 * Unauthenticated on purpose: a CSRF token is not a secret, it is a value the
 * attacker's origin cannot READ. Cross-origin callers get a token minted
 * against a cookie their fetch can never store — useless for forging a request
 * from the victim's browser, which still carries the victim's own cookie. The
 * token is bound to the caller's cookie, so it is never a shared value.
 */
export default defineEventHandler((event) => {
	const token = event.context['csrfToken'];
	if (typeof token !== 'string' || !token) {
		// `security.csrf` is off, or the module's request hook did not run: there
		// is no token to hand out and no middleware demanding one either.
		throw createError({ statusCode: 503, message: 'CSRF tokens are not enabled' });
	}
	// The cookie this token is bound to is set on this very response; a cached
	// copy would hand a later tab a token for a cookie it does not have.
	setHeader(event, 'cache-control', 'no-store');
	return { token };
});
