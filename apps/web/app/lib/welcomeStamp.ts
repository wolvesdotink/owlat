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
 * goes out as an anonymous caller, then sends it with a deadline. A failure is
 * retried with the same bounded backoff the first-login middleware uses for its
 * query. Every failure is logged with its cause, so a browser console shows why.
 * The welcomed cache is written only after a commit: it must never claim a stamp
 * the server does not have.
 *
 * The caller owns the run through an `AbortSignal`. Aborting (the page unmounted,
 * a different member signed in) drops the auth wait and any pending backoff, and
 * nothing is sent after it. A send already in flight cannot be recalled; if it
 * commits, its stamp is true and is cached as usual.
 */
import { whenConvexAuthenticated } from '~/lib/convexAuthReady';
import { TRANSIENT_RETRY_LIMIT, transientRetryDelay } from '~/lib/queryRetry';
import { logError, logWarn } from '~/lib/runtimeLog';
import { writeWelcomedCache } from '~/lib/welcomedCache';

/** How long one attempt waits for the client to report an authenticated token. */
export const WELCOME_STAMP_AUTH_WAIT_MS = 10_000;

/**
 * How long one send may take before the attempt counts as failed. A Convex
 * mutation runs for at most a second; this covers a slow round trip, and keeps a
 * send that never answers from holding the whole run open.
 */
export const WELCOME_STAMP_SEND_DEADLINE_MS = 15_000;

export type WelcomeStampResult = 'saved' | 'failed' | 'aborted';

export interface WelcomeStampOptions {
	userId: string;
	/** Sends `markWelcomed`; resolves once the mutation has committed. */
	send: () => Promise<unknown>;
	/** Ends the run: no further wait, backoff or send. */
	signal?: AbortSignal;
}

class SendDeadlineError extends Error {
	constructor() {
		super(`markWelcomed did not answer within ${WELCOME_STAMP_SEND_DEADLINE_MS} ms`);
	}
}

/** `send()`, rejected with a {@link SendDeadlineError} if it outlives the deadline. */
function sendWithDeadline(send: () => Promise<unknown>): Promise<unknown> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new SendDeadlineError()), WELCOME_STAMP_SEND_DEADLINE_MS);
	});
	return Promise.race([send(), deadline]).finally(() => clearTimeout(timer));
}

/** Resolves after `ms`, or at once when `signal` aborts; the timer is cleared either way. */
function backoff(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve();
		const done = () => {
			clearTimeout(timer);
			signal?.removeEventListener('abort', done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal?.addEventListener('abort', done, { once: true });
	});
}

/**
 * `'saved'` once the stamp has committed and been cached on this device,
 * `'failed'` after the first try and {@link TRANSIENT_RETRY_LIMIT} retries have
 * all failed, `'aborted'` when `signal` ended the run first. Never rejects.
 */
export async function stampWelcomed({
	userId,
	send,
	signal,
}: WelcomeStampOptions): Promise<WelcomeStampResult> {
	const attempts = TRANSIENT_RETRY_LIMIT + 1;
	let lastFailure: unknown = null;
	for (let attempt = 0; ; attempt++) {
		const label = `[welcome] markWelcomed attempt ${attempt + 1}/${attempts}`;
		const authenticated = await whenConvexAuthenticated(WELCOME_STAMP_AUTH_WAIT_MS, signal);
		if (signal?.aborted) return 'aborted';
		if (authenticated) {
			try {
				await sendWithDeadline(send);
				writeWelcomedCache(userId);
				return 'saved';
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
			return 'failed';
		}
		await backoff(transientRetryDelay(attempt), signal);
		if (signal?.aborted) return 'aborted';
	}
}
