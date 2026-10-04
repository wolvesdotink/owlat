/**
 * Re-installing Convex auth after the client gave up while the session may
 * still be fine.
 *
 * When the Convex client reports a definitive auth failure it drops its auth
 * config, so nothing fetches a token again until `setAuth` is called anew. The
 * plugin (plugins/convex.client.ts) calls {@link ConvexAuthRecovery.retry} when
 * that failure did not come from a dead session: the token request never got an
 * answer, or the session is valid and the server still turned the token away.
 * This schedules `reinstall` after 1 s, 2 s, 4 s, ... with jitter, so the tabs
 * of one browser do not all ask in the same instant, and stops after
 * `maxAttempts`. A tab whose session is gone never gets here: the plugin takes
 * the sign-out path for it and calls {@link ConvexAuthRecovery.reset}.
 *
 * Kept free of Nuxt and Convex imports so it runs under vitest as-is.
 */

export type ConvexAuthFailure =
	/** The token request got no usable answer (network, timeout, 5xx). */
	| 'unreachable'
	/** The session is valid, yet no token was accepted: an auth config problem, or a flaky server. */
	| 'rejected';

export interface ConvexAuthRecoveryOptions {
	/** Reset the token cache and call `client.setAuth` again. */
	reinstall: () => void;
	/** Every attempt is spent. Called once per streak, with the last failure. */
	onGiveUp: (failure: ConvexAuthFailure) => void;
	/** A streak ended in success or was superseded, after {@link ConvexAuthRecoveryOptions.onGiveUp} ran. */
	onRecovered?: () => void;
	maxAttempts?: number;
	baseDelayMs?: number;
	maxDelayMs?: number;
	/** Injected for tests; `Math.random` otherwise. */
	random?: () => number;
}

export interface ConvexAuthRecovery {
	/**
	 * Auth failed while the session may be fine. Schedules the next reinstall and
	 * returns `true`, or returns `false` once every attempt is spent (and reports
	 * that through `onGiveUp`, once). A call while a reinstall is already
	 * scheduled is ignored.
	 */
	retry(failure: ConvexAuthFailure): boolean;
	/**
	 * Auth succeeded, a new identity was installed (session signal), or the
	 * session is gone: cancel any scheduled reinstall and start the next streak
	 * with the full budget.
	 */
	reset(): void;
	/**
	 * Try again now, with a fresh budget, if every attempt is spent (for example
	 * when the browser comes back online). Does nothing otherwise.
	 */
	resume(): void;
}

export const CONVEX_AUTH_RETRY_MAX_ATTEMPTS = 5;
export const CONVEX_AUTH_RETRY_BASE_DELAY_MS = 1_000;
export const CONVEX_AUTH_RETRY_MAX_DELAY_MS = 30_000;

export function createConvexAuthRecovery(options: ConvexAuthRecoveryOptions): ConvexAuthRecovery {
	const maxAttempts = options.maxAttempts ?? CONVEX_AUTH_RETRY_MAX_ATTEMPTS;
	const baseDelayMs = options.baseDelayMs ?? CONVEX_AUTH_RETRY_BASE_DELAY_MS;
	const maxDelayMs = options.maxDelayMs ?? CONVEX_AUTH_RETRY_MAX_DELAY_MS;
	const random = options.random ?? Math.random;

	let attempts = 0;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let gaveUp = false;

	const cancel = () => {
		if (timer !== null) clearTimeout(timer);
		timer = null;
	};

	const reset = () => {
		cancel();
		attempts = 0;
		if (gaveUp) {
			gaveUp = false;
			options.onRecovered?.();
		}
	};

	return {
		retry(failure) {
			if (timer !== null) return true;
			if (attempts >= maxAttempts) {
				if (!gaveUp) {
					gaveUp = true;
					options.onGiveUp(failure);
				}
				return false;
			}
			const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** attempts);
			attempts++;
			// Up to half the delay again: tabs that failed together spread out.
			timer = setTimeout(
				() => {
					timer = null;
					options.reinstall();
				},
				delay + Math.floor(random() * (delay / 2))
			);
			return true;
		},
		reset,
		resume() {
			// Only once the budget is spent, so a burst of events cannot stack
			// streaks. `gaveUp` stays set: the notice stays up until auth works,
			// and a resumed streak that fails too does not report again.
			if (!gaveUp || attempts < maxAttempts) return;
			attempts = 0;
			options.reinstall();
		},
	};
}
