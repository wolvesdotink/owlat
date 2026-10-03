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
	// A waiter removes itself once it accepts a report; deleting the visited
	// entry is safe mid-iteration.
	for (const settle of waiters) settle(isAuthenticated);
}

/**
 * Wait for an auth report that `accept`s, up to `timeoutMs`. Resolves the
 * accepted report's answer, or `false` on timeout or when `signal` aborts; the
 * waiter and its timer are removed either way. Never rejects.
 */
function waitForReport(
	timeoutMs: number,
	accept: (authenticated: boolean) => boolean,
	signal?: AbortSignal
) {
	return new Promise<boolean>((resolve) => {
		if (signal?.aborted) return resolve(false);
		const finish = (answer: boolean) => {
			clearTimeout(timer);
			waiters.delete(settle);
			signal?.removeEventListener('abort', onAbort);
			resolve(answer);
		};
		const settle = (authenticated: boolean) => {
			if (accept(authenticated)) finish(authenticated);
		};
		const onAbort = () => finish(false);
		const timer = setTimeout(() => finish(false), timeoutMs);
		waiters.add(settle);
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

/**
 * Resolves `true` once the server has confirmed the current token, `false` when
 * auth failed or nothing settled within `timeoutMs` (no auth was ever installed,
 * say, because the app booted on a public page). Never rejects.
 */
export function whenConvexAuthSettled(timeoutMs = 10_000): Promise<boolean> {
	if (state !== 'pending') return Promise.resolve(state === 'authenticated');
	return waitForReport(timeoutMs, () => true);
}

/**
 * Resolves `true` once the client is authenticated: at once if it already is,
 * otherwise on the next report that says so. Unlike {@link whenConvexAuthSettled}
 * a failed report does not end the wait, because the client may install a new
 * token (a session signal re-runs `setAuth`) and succeed with it. Resolves
 * `false` if no authenticated report arrives within `timeoutMs`, or as soon as
 * `signal` aborts (the caller went away). Never rejects.
 *
 * For a one-shot call that must not run as an anonymous caller and can afford
 * to wait for the next token, such as the welcome stamp.
 */
export function whenConvexAuthenticated(
	timeoutMs = 10_000,
	signal?: AbortSignal
): Promise<boolean> {
	if (signal?.aborted) return Promise.resolve(false);
	if (state === 'authenticated') return Promise.resolve(true);
	return waitForReport(timeoutMs, (authenticated) => authenticated, signal);
}
