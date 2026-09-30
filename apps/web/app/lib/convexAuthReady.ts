/**
 * Whether the Convex client's CURRENT auth config has settled, and how.
 *
 * `convex.client.ts` installs the token fetcher with `setAuth` at boot and again
 * on every better-auth session signal (sign-in, sign-out, organization switch).
 * Until the server confirms that token, a one-shot `$convex.query` can run as an
 * anonymous caller and a `requireSelf` query throws. Subscriptions shrug that
 * off because the server re-runs them once auth lands; a one-shot query does
 * not, so code that runs straight after a SPA sign-in (the first-login check)
 * waits here first.
 *
 * The plugin marks the state pending before each `setAuth` and reports the
 * client's `onChange` answer. Nothing here fetches or caches a token.
 */

type ConvexAuthState = 'pending' | 'authenticated' | 'unauthenticated';

let state: ConvexAuthState = 'pending';
const waiters = new Set<(authenticated: boolean) => void>();

/** A new auth config is being installed; its answer is not known yet. */
export function markConvexAuthPending(): void {
	state = 'pending';
}

/** The Convex client's `setAuth` onChange: the server accepted the token, or auth failed. */
export function reportConvexAuth(isAuthenticated: boolean): void {
	state = isAuthenticated ? 'authenticated' : 'unauthenticated';
	for (const settle of [...waiters]) settle(isAuthenticated);
}

/**
 * Resolves `true` once the server has confirmed the current token, `false` when
 * auth failed or nothing settled within `timeoutMs` (no auth was ever installed,
 * say, because the app booted on a public page). Never rejects.
 */
export function whenConvexAuthSettled(timeoutMs = 10_000): Promise<boolean> {
	if (state !== 'pending') return Promise.resolve(state === 'authenticated');
	return new Promise((resolve) => {
		const settle = (authenticated: boolean) => {
			clearTimeout(timer);
			waiters.delete(settle);
			resolve(authenticated);
		};
		const timer = setTimeout(() => settle(false), timeoutMs);
		waiters.add(settle);
	});
}
