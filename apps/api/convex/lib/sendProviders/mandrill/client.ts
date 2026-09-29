/**
 * The one HTTP client for Mandrill's JSON API.
 *
 * Both Mandrill callers go through here: the send adapter
 * (`messages/send-raw`, `./index.ts`) and the sender-domain client
 * (`senders/*`, `domains/providers/mandrill/api.ts`). The base URL, the timeout
 * and abort handling, the error-body reading and the key redaction therefore
 * exist once.
 *
 * THE API KEY TRAVELS IN THE REQUEST BODY (Mandrill convention). It never
 * reaches a URL or a header, but a proxy or gateway that echoes what it
 * received hands the credential straight back, and a JSON parse error on such a
 * body quotes it. So nothing this module returns or throws may contain the key:
 * every surfaced error string and every rethrown message goes through
 * {@link redactSecret}.
 *
 * No `'use node'`: only `fetch` and a timer are used, so the V8 domain client
 * can import it as well as the Node send worker.
 */

import { withTimeout } from '../../inputGuards';
import { redactSecret } from '../../redactSecret';

/**
 * Constant, not configurable: the EU region is served from this same host, and
 * a per-deployment base URL would be an SSRF-shaped knob on requests that carry
 * the API key in their body.
 */
export const MANDRILL_API_BASE = 'https://mandrillapp.com/api/1.0';

/**
 * A Mandrill failure body, split by audience.
 *
 * `classifyText` is what the error taxonomy reads and is discarded afterwards;
 * `surfaced` is the only part that may reach `emailSends.errorMessage`, a log
 * sink or an operator's screen.
 */
interface MandrillApiError {
	readonly surfaced: string;
	readonly classifyText: string;
}

/**
 * Read Mandrill's `{ status: 'error', code, name, message }` failure body.
 *
 * Only the two STRUCTURED fields of a body that actually parses as a Mandrill
 * error are ever surfaced. Anything else (a gateway error page, a truncated
 * body, an echo of our own request) is classified from its text but surfaced
 * as `${fallbackLabel} (HTTP ${status})` alone. Copying an unstructured body
 * into the surfaced message would persist the key, which is what
 * `__tests__/transportSecrets.test.ts` caught.
 */
function readMandrillApiError(
	body: string,
	status: number,
	fallbackLabel: string
): MandrillApiError {
	try {
		const parsed = JSON.parse(body) as Record<string, unknown>;
		const name = typeof parsed['name'] === 'string' ? parsed['name'] : '';
		const message = typeof parsed['message'] === 'string' ? parsed['message'] : '';
		if (name || message) {
			return {
				surfaced: name ? `${name}: ${message}` : message,
				classifyText: `${name}: ${message}`,
			};
		}
	} catch {
		// Not JSON. Classify from the text, surface none of it.
	}
	return { surfaced: `${fallbackLabel} (HTTP ${status})`, classifyText: body };
}

/** What one Mandrill call answered. A failed request is thrown, not returned. */
type MandrillPostResult =
	| { readonly ok: true; readonly payload: unknown }
	| {
			readonly ok: false;
			readonly status: number;
			/** The raw `Retry-After` header, for the caller's own parser. */
			readonly retryAfter: string | null;
			/** Already redacted: the key cannot appear in `surfaced` or `classifyText`. */
			readonly error: MandrillApiError;
	  };

interface PostMandrillOptions {
	/** Upper bound on waiting for the response headers. */
	readonly timeoutMs: number;
	/**
	 * The message the timeout rejects with. Callers match it (as the sentinel of
	 * `isAmbiguousPostDispatchTimeout`), so it survives the rethrow unchanged.
	 */
	readonly timeoutMessage: string;
	/** Surfaced as `${failureLabel} (HTTP ${status})` for a body that is not a Mandrill error. */
	readonly failureLabel: string;
}

/**
 * POST `body` to `${MANDRILL_API_BASE}${path}` and read the answer.
 *
 * A non-2xx answer is returned as `{ ok: false }` with its error already read
 * and redacted. A 2xx answer is parsed as JSON inside the same deadline scope,
 * because the request is aborted once this function settles and a body read
 * after that would fail.
 *
 * Anything thrown (network failure, the timeout, a JSON parse error quoting an
 * echoed body) is rethrown as a fresh `Error` whose message has the key
 * redacted and whose `name` is kept, so a caller still recognises a
 * `TimeoutError`/`AbortError` or the timeout sentinel. The original error is
 * not attached as `cause`: its own fields may quote the request.
 */
export async function postMandrill<Body extends { readonly key: string }>(
	path: `/${string}`,
	body: Body,
	options: PostMandrillOptions
): Promise<MandrillPostResult> {
	const abort = new AbortController();
	try {
		const response = await withTimeout(
			fetch(`${MANDRILL_API_BASE}${path}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
				signal: abort.signal,
			}),
			options.timeoutMs,
			options.timeoutMessage
		);

		if (!response.ok) {
			const text = await response.text().catch(() => '');
			const error = readMandrillApiError(text, response.status, options.failureLabel);
			return {
				ok: false,
				status: response.status,
				retryAfter: response.headers.get('Retry-After'),
				error: {
					surfaced: redactSecret(error.surfaced, body.key),
					classifyText: redactSecret(error.classifyText, body.key),
				},
			};
		}

		return { ok: true, payload: (await response.json()) as unknown };
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		const redacted = new Error(redactSecret(error.message, body.key));
		redacted.name = error.name;
		throw redacted;
	} finally {
		// Promise.race cannot cancel its losing branch. Abort so a timed-out
		// request does not continue in the background.
		abort.abort();
	}
}
