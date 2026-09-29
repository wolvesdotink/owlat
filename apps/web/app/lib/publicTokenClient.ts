/**
 * The recipient pages' one way to call a public, token-keyed Convex HTTP
 * endpoint (`/unsub/...`, `/prefs/...`, `/share/...`, `/archive/...`).
 *
 * Those endpoints answer in two shapes (see the API's `publicTokenEndpoint`):
 *
 *   - outcome mode, always HTTP 200: `{ ok: true, data }` or `{ ok: false, reason }`;
 *   - action mode: `{ ok: true, data }` on success, otherwise a 4xx carrying
 *     the error envelope `{ error: { category, message, data: { reason } } }`.
 *
 * Both collapse to one result here, so a page branches on a machine-readable
 * `reason` and never on an HTTP status or on the backend's English `message`.
 * A request that never got a readable answer gets a transport reason instead
 * (`PUBLIC_TOKEN_REASONS`). This never throws.
 */

export type PublicTokenResult<T> = { ok: true; data: T } | { ok: false; reason: string };

/** Reasons this client produces itself, next to the ones the server sends. */
export const PUBLIC_TOKEN_REASONS = {
	/** The request never completed (offline, DNS, CORS, aborted). */
	network: 'network_error',
	/** An answer arrived but was not JSON, or not either envelope. */
	badResponse: 'bad_response',
	/** The endpoint's rate limit refused the request. */
	rateLimited: 'rate_limited',
} as const;

interface OutcomeBody {
	ok?: unknown;
	data?: unknown;
	reason?: unknown;
	error?: { category?: unknown; data?: { reason?: unknown } };
}

/** Read one parsed body (or `null` for none) into the result shape. */
export function readPublicTokenBody<T>(
	httpOk: boolean,
	status: number,
	body: unknown
): PublicTokenResult<T> {
	const parsed = (body && typeof body === 'object' ? body : null) as OutcomeBody | null;
	if (httpOk && parsed?.ok === true && parsed.data !== undefined) {
		return { ok: true, data: parsed.data as T };
	}
	if (typeof parsed?.reason === 'string') return { ok: false, reason: parsed.reason };
	const envelopeReason = parsed?.error?.data?.reason;
	if (typeof envelopeReason === 'string') return { ok: false, reason: envelopeReason };
	if (status === 429 || parsed?.error?.category === 'rate_limited') {
		return { ok: false, reason: PUBLIC_TOKEN_REASONS.rateLimited };
	}
	return { ok: false, reason: PUBLIC_TOKEN_REASONS.badResponse };
}

/**
 * `fetch` `${convexSiteUrl}/<path>/<token>`, the token URL-encoded.
 *
 * @param path  the route without slashes around it, e.g. `'unsub/verify'`
 */
export async function fetchPublicToken<T>(
	path: string,
	token: string,
	init?: RequestInit
): Promise<PublicTokenResult<T>> {
	const url = `${useRuntimeConfig().public.convexSiteUrl}/${path}/${encodeURIComponent(token)}`;
	let response: Response;
	try {
		response = await fetch(url, init);
	} catch {
		return { ok: false, reason: PUBLIC_TOKEN_REASONS.network };
	}
	const body: unknown = await response.json().catch(() => null);
	return readPublicTokenBody<T>(response.ok, response.status, body);
}
