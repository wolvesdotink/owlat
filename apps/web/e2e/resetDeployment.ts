/**
 * `POST /dev/reset` against the test deployment, which the E2E workflow calls
 * twice: before the suite, for a blank slate, and after it, always, to end the
 * run's sessions.
 *
 * The reset deletes the seeded owner together with every session row
 * (convex/devShortcuts/reset.ts). The owner's password is fixed in this
 * repository, and the session cookie and Convex JWT exist in the runner's
 * memory, storage state and anything the run recorded. Resetting when the run
 * ends means none of them authenticates afterwards, apart from BetterAuth's
 * cookie cache window (about five minutes), which no server-side delete can
 * close. Without it the account stayed usable until the next run's reset, up
 * to a day later.
 *
 * So a transient failure must not cost the reset. A network error, a timeout,
 * a reply whose body breaks off, and HTTP 408, 425, 429 and 5xx are retried
 * with exponential backoff (a 429's `Retry-After` is honoured), within a
 * bounded number of attempts and one overall deadline. Any other status, an
 * auth failure above all, is definitive and fails at once, as does a 200 that
 * is not the endpoint's answer. Running out of attempts or time fails too, so
 * the workflow step fails visibly. The reset is idempotent, so repeating one
 * that did run server-side is harmless.
 *
 * Sent with Node's `fetch`, never Playwright's, for the reason seedAdmin.ts
 * gives. Errors and retry lines name the HTTP status and the response body,
 * never the request headers or the deployment URL.
 */

import { unreachableError } from './reportRedaction';

export interface ResetResult {
	/** Rows deleted per table, as the endpoint reports them. */
	deleted: Record<string, number>;
}

export interface ResetOptions {
	siteUrl: string;
	instanceSecret: string;
	fetchImpl?: typeof fetch;
	/** Budget for one attempt, request and body. The old inline curl allowed 120 s. */
	timeoutMs?: number;
	/** Attempts in all, the first included. */
	attempts?: number;
	/** Budget for every attempt and wait together; no attempt starts past it. */
	deadlineMs?: number;
	/** Wait before the second attempt; it doubles after each failure, up to {@link MAX_BACKOFF_MS}. */
	backoffMs?: number;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	/** Where a retry is announced. */
	log?: (line: string) => void;
}

const REQUEST = 'POST /dev/reset';

/** Long enough for the reply to explain itself, short enough for one log line. */
const MAX_BODY_IN_ERROR = 500;

const MAX_BACKOFF_MS = 30_000;

/** The default overall deadline. The workflow's step timeout sits above it. */
export const RESET_DEADLINE_MS = 300_000;

/** Statuses that say "not now" rather than "no". */
function isRetryableStatus(status: number): boolean {
	return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** One attempt's failure, and whether another attempt could succeed. */
class AttemptFailure extends Error {
	constructor(
		message: string,
		readonly retryable: boolean,
		readonly retryAfterMs = 0
	) {
		super(message);
	}
}

/** `Retry-After` in milliseconds, for its delay-seconds form; 0 when absent or a date. */
function retryAfterMs(response: Response): number {
	const seconds = Number(response.headers.get('retry-after'));
	return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

async function attempt(
	options: Required<Pick<ResetOptions, 'siteUrl' | 'instanceSecret' | 'fetchImpl'>>,
	timeoutMs: number
): Promise<ResetResult> {
	const signal = AbortSignal.timeout(timeoutMs);
	let response: Response;
	let body: string;
	try {
		response = await options.fetchImpl(`${options.siteUrl}/dev/reset`, {
			method: 'POST',
			headers: { 'X-Instance-Secret': options.instanceSecret },
			signal,
		});
	} catch (error) {
		throw new AttemptFailure(unreachableError(REQUEST, error).message, true);
	}
	try {
		body = await response.text();
	} catch (error) {
		const timedOut = (error as { name?: unknown } | null)?.name === 'TimeoutError';
		throw new AttemptFailure(
			`${REQUEST} returned HTTP ${response.status}, but reading its body ${timedOut ? 'timed out' : 'failed'}.`,
			true
		);
	}
	if (response.status !== 200) {
		throw new AttemptFailure(
			`${REQUEST} returned HTTP ${response.status}: ${body.slice(0, MAX_BODY_IN_ERROR)}`,
			isRetryableStatus(response.status),
			response.status === 429 ? retryAfterMs(response) : 0
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		throw new AttemptFailure(`${REQUEST} answered 200 with a body that is not JSON.`, false);
	}
	const deleted = (parsed as { deleted?: unknown } | null)?.deleted;
	if (typeof deleted !== 'object' || deleted === null) {
		throw new AttemptFailure(`${REQUEST} answered 200 without the deleted counts.`, false);
	}
	return { deleted: deleted as Record<string, number> };
}

export async function resetDeployment(options: ResetOptions): Promise<ResetResult> {
	const {
		siteUrl,
		instanceSecret,
		fetchImpl = fetch,
		timeoutMs = 120_000,
		attempts = 5,
		deadlineMs = RESET_DEADLINE_MS,
		backoffMs = 2_000,
		sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		now = Date.now,
		log = () => {},
	} = options;
	const deadline = now() + deadlineMs;
	for (let number = 1; ; number++) {
		const remaining = deadline - now();
		let failure: AttemptFailure;
		try {
			return await attempt({ siteUrl, instanceSecret, fetchImpl }, Math.min(timeoutMs, remaining));
		} catch (error) {
			failure =
				error instanceof AttemptFailure ? error : new AttemptFailure(`${REQUEST} failed.`, false);
		}
		// Thrown as plain Errors: nothing chained, so nothing names the host.
		if (!failure.retryable) throw new Error(failure.message);
		if (number >= attempts) {
			throw new Error(`${failure.message} Gave up after ${number} attempts.`);
		}
		const wait = Math.max(
			Math.min(backoffMs * 2 ** (number - 1), MAX_BACKOFF_MS),
			failure.retryAfterMs
		);
		if (now() + wait >= deadline) {
			const seconds = Math.round(deadlineMs / 1000);
			throw new Error(
				`${failure.message} Gave up after ${number} attempts: the ${seconds} s deadline leaves no time for another.`
			);
		}
		const waitSeconds = Math.round(wait / 1000);
		log(
			`${REQUEST} attempt ${number} of ${attempts} failed: ${failure.message} Retrying in ${waitSeconds} s.`
		);
		await sleep(wait);
	}
}
