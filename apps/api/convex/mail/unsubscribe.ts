'use node';

/**
 * RFC 8058 One-Click unsubscribe for Postbox list mail.
 *
 * Every person-facing unsubscribe (the reader's chip, ⇧O, the Senders page,
 * the Subscriptions panel) reaches this POST through
 * `mail/senders/unsubscribeActions.ts`, after an explicit user confirmation;
 * the POST happens server-side (the sender's endpoint
 * never sees the user's browser/IP context, and the request works even when
 * the endpoint lacks CORS). The target URL comes from an attacker-controlled
 * mail header. The shared URL policy requires https without credentials or
 * literal/local hosts; fetchGuarded additionally validates DNS answers before
 * the request and at socket connection time to prevent DNS rebinding.
 *
 * Fail-soft: network errors, timeouts, and non-2xx responses come back as
 * `{ ok: false }` for a toast — never a thrown error, and nothing about the
 * message is modified either way.
 */

import { isSafeUnsubscribeUrl } from '@owlat/shared/listUnsubscribe';
import { fetchGuarded, SsrfBlockedError } from '../lib/ssrfGuard';

/** Bounded wait for the sender's unsubscribe endpoint. */
export const ONE_CLICK_TIMEOUT_MS = 10_000;

export type OneClickResult = { ok: true } | { ok: false; error: string };

/**
 * Perform the RFC 8058 POST (`List-Unsubscribe=One-Click` form body) against
 * a One-Click https URL. Pure (fetch injected) so it unit-tests with a spy,
 * mirroring `delivery.scanInboundAttachments`.
 *
 * Redirects are NOT followed (`redirect: 'manual'`): the SSRF guard vetted
 * only this URL, and RFC 8058 §3.2 expects the endpoint itself to accept the
 * POST. The response body is never surfaced to the caller.
 */
export async function postOneClickUnsubscribe(
	url: string,
	fetchImpl: (url: string, init: RequestInit) => Promise<Response> = fetchGuarded
): Promise<OneClickResult> {
	if (!isSafeUnsubscribeUrl(url)) return { ok: false, error: 'unsafe_url' };
	try {
		const res = await fetchImpl(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'List-Unsubscribe=One-Click',
			redirect: 'manual',
			signal: AbortSignal.timeout(ONE_CLICK_TIMEOUT_MS),
		});
		// Only the status matters; do not retain an untrusted response stream.
		void res.body?.cancel().catch(() => undefined);
		if (res.ok) return { ok: true };
		return { ok: false, error: `http_${res.status}` };
	} catch (error) {
		return { ok: false, error: error instanceof SsrfBlockedError ? 'unsafe_url' : 'network' };
	}
}
