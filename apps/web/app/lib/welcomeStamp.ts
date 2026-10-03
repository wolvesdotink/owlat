/**
 * Stamp `welcomedAt` from the welcome screen, retrying a failed attempt (#1203).
 *
 * The stamp is sent straight after sign-in, when the Convex client may still be
 * re-authenticating (the `auth` middleware activates the organization, and each
 * session signal re-runs `setAuth`) and when a cold deployment can time a
 * function out. One failed attempt used to be final: the member was sent back to
 * `/welcome` in their next session, and the E2E setup waited on a cache entry
 * that was never written.
 *
 * Each attempt waits until the client is authenticated, so the mutation never
 * goes out as an anonymous caller, then sends it. A failure is retried with the
 * same bounded backoff the first-login middleware uses for its query. Every
 * failure is logged with its cause, so a browser console shows why. The welcomed
 * cache is written only after a commit: it must never claim a stamp the server
 * does not have.
 */
import { whenConvexAuthenticated } from '~/lib/convexAuthReady';
import { TRANSIENT_RETRY_LIMIT, transientRetryDelay } from '~/lib/queryRetry';
import { logError, logWarn } from '~/lib/runtimeLog';
import { writeWelcomedCache } from '~/lib/welcomedCache';

/** How long one attempt waits for the client to report an authenticated token. */
export const WELCOME_STAMP_AUTH_WAIT_MS = 10_000;

export interface WelcomeStampOptions {
	userId: string;
	/** Sends `markWelcomed`; resolves once the mutation has committed. */
	send: () => Promise<unknown>;
}

/**
 * Resolves `true` once the stamp has committed and been cached on this device,
 * `false` after the first try and {@link TRANSIENT_RETRY_LIMIT} retries have all
 * failed. Never rejects.
 */
export async function stampWelcomed({ userId, send }: WelcomeStampOptions): Promise<boolean> {
	const attempts = TRANSIENT_RETRY_LIMIT + 1;
	let lastFailure: unknown = null;
	for (let attempt = 0; ; attempt++) {
		const label = `[welcome] markWelcomed attempt ${attempt + 1}/${attempts}`;
		if (await whenConvexAuthenticated(WELCOME_STAMP_AUTH_WAIT_MS)) {
			try {
				await send();
				writeWelcomedCache(userId);
				return true;
			} catch (error) {
				lastFailure = error;
				logWarn(`${label} failed:`, error);
			}
		} else {
			lastFailure = 'Convex client not authenticated';
			logWarn(
				`${label} not sent: the Convex client did not report an authenticated token within ${WELCOME_STAMP_AUTH_WAIT_MS} ms.`
			);
		}
		if (attempt >= TRANSIENT_RETRY_LIMIT) {
			logError(`[welcome] Giving up on markWelcomed after ${attempts} attempts:`, lastFailure);
			return false;
		}
		await new Promise((resolve) => setTimeout(resolve, transientRetryDelay(attempt)));
	}
}
