'use node';

/**
 * Connected-app connection test — Node-runtime reachability probe (Tier 2).
 *
 * The registration UX lets an operator confirm that an app's hook endpoint is
 * actually reachable before they rely on it. This is a plain, unsigned probe:
 * it carries NO shared secret and grants the app nothing — it only tells the
 * operator whether *something* is listening at the configured HTTPS URL and how
 * it responded. The signed synchronous-hook protocol is a separate concern
 * (PP-24); nothing here is a hook.
 *
 * Every Tier-2 network invariant is honored:
 *   - the fetch goes through {@link fetchGuarded}, so the destination is checked
 *     against the private/internal SSRF blocklist up front AND re-validated at
 *     connect time (DNS-rebinding defense), and any redirect is refused;
 *   - the request is bounded by a short deadline (`AbortSignal.timeout`) so a
 *     hanging endpoint cannot stall the action;
 *   - the response body is drained and discarded under a hard byte cap so an
 *     oversized reply cannot exhaust memory;
 *   - every failure mode is caught and mapped to a structured result — the probe
 *     NEVER throws — so the caller always fails closed to a clear "unreachable".
 */

import {
	CONNECTED_APP_TEST_MAX_RESPONSE_BYTES,
	CONNECTED_APP_TEST_TIMEOUT_MS,
} from '../lib/constants';
import { fetchGuarded, readCappedBytes, CappedReadOverflow } from '../lib/ssrfGuard';

/**
 * The outcome of a connection test:
 *   - `ok`          — the endpoint answered with a 2xx status.
 *   - `error_status`— something is listening but it answered non-2xx (reachable,
 *                     but the app reported a problem).
 *   - `unreachable` — no usable response: DNS/network failure, timeout, a
 *                     refused redirect, or an SSRF-blocked destination.
 *   - `blocked`     — the test was refused before any request (e.g. a revoked
 *                     app whose endpoint must not be probed).
 */
export type ConnectedAppConnectionTestOutcome = 'ok' | 'error_status' | 'unreachable' | 'blocked';

/** Structured, secret-free result surfaced to the registration UX. */
export interface ConnectedAppConnectionTestResult {
	readonly outcome: ConnectedAppConnectionTestOutcome;
	/** The HTTP status when a response arrived, else `null`. */
	readonly status: number | null;
	/** A short, operator-facing explanation. Never contains secret material. */
	readonly message: string;
}

/** Drain and discard a response body under the byte cap, ignoring read errors. */
async function drainBody(response: Response): Promise<void> {
	try {
		await readCappedBytes(response.body, CONNECTED_APP_TEST_MAX_RESPONSE_BYTES);
	} catch (error) {
		// An over-cap body is fine here — the probe only needs the status line, so
		// we intentionally ignore both the overflow and any late stream error.
		if (!(error instanceof CappedReadOverflow)) {
			// Swallow: draining is best-effort cleanup, never a probe failure.
		}
	}
}

/**
 * Probe `endpointUrl` for reachability. Sends one bounded, SSRF-guarded POST with
 * a self-identifying, non-hook test envelope and maps the result to a structured
 * outcome. Always resolves — every error becomes `unreachable`.
 */
export async function probeConnectedAppEndpoint(
	endpointUrl: string
): Promise<ConnectedAppConnectionTestResult> {
	let response: Response;
	try {
		response = await fetchGuarded(endpointUrl, {
			method: 'POST',
			protocols: ['https:'],
			headers: {
				'content-type': 'application/json',
				// Marks the request as a connectivity probe so a receiver can safely
				// ignore it — it is deliberately unsigned and side-effect-free.
				'x-owlat-connection-test': '1',
			},
			body: JSON.stringify({ type: 'owlat.connection_test' }),
			signal: AbortSignal.timeout(CONNECTED_APP_TEST_TIMEOUT_MS),
		});
	} catch (error) {
		return { outcome: 'unreachable', status: null, message: describeProbeFailure(error) };
	}

	await drainBody(response);

	const status = response.status;
	if (status >= 200 && status < 300) {
		return { outcome: 'ok', status, message: `Endpoint responded successfully (HTTP ${status}).` };
	}
	return {
		outcome: 'error_status',
		status,
		message: `Endpoint is reachable but returned HTTP ${status}.`,
	};
}

/** Map a thrown fetch failure to a short, safe, operator-facing reason. */
function describeProbeFailure(error: unknown): string {
	// `AbortSignal.timeout` rejects with a DOMException whose name is 'TimeoutError'.
	if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
		return `Connection timed out after ${CONNECTED_APP_TEST_TIMEOUT_MS / 1000}s.`;
	}
	if (error instanceof Error && /refusing to follow redirect/i.test(error.message)) {
		return 'Endpoint attempted a redirect, which is not allowed.';
	}
	if (error instanceof Error && /disallowed \(private\/internal\)/i.test(error.message)) {
		return 'Endpoint resolves to a private or internal address and cannot be reached.';
	}
	return 'Could not reach the endpoint. Check the URL and that the service is online.';
}
