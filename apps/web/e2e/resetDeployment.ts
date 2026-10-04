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
 * Sent with Node's `fetch`, never Playwright's, for the reason seedAdmin.ts
 * gives. Errors name the HTTP status and the response body, never the request
 * headers or the deployment URL.
 */

import { unreachableError } from './reportRedaction';

export interface ResetResult {
	/** Rows deleted per table, as the endpoint reports them. */
	deleted: Record<string, number>;
}

/** Long enough for the reply to explain itself, short enough for one log line. */
const MAX_BODY_IN_ERROR = 500;

export async function resetDeployment(options: {
	siteUrl: string;
	instanceSecret: string;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}): Promise<ResetResult> {
	const { siteUrl, instanceSecret, fetchImpl = fetch, timeoutMs = 120_000 } = options;
	let response: Response;
	try {
		response = await fetchImpl(`${siteUrl}/dev/reset`, {
			method: 'POST',
			headers: { 'X-Instance-Secret': instanceSecret },
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (error) {
		throw unreachableError('POST /dev/reset', error);
	}
	const body = await response.text();
	if (response.status !== 200) {
		throw new Error(
			`POST /dev/reset returned HTTP ${response.status}: ${body.slice(0, MAX_BODY_IN_ERROR)}`
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		throw new Error('POST /dev/reset answered 200 with a body that is not JSON.');
	}
	const deleted = (parsed as { deleted?: unknown } | null)?.deleted;
	if (typeof deleted !== 'object' || deleted === null) {
		throw new Error('POST /dev/reset answered 200 without the deleted counts.');
	}
	return { deleted: deleted as Record<string, number> };
}
