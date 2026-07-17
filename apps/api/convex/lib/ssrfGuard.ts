'use node';

/**
 * SSRF guard for server-side fetches of user-supplied URLs.
 *
 * Any place the backend fetches a URL that an API consumer or org member can
 * influence (webhook delivery, email attachment URLs, link/image fetching,
 * imports) MUST route through here. Without it, an attacker can point the URL
 * at an internal host or a public name that resolves to a private/link-local
 * address (cloud metadata at 169.254.169.254, the MTA control API, internal
 * dashboards) and — when the response is reflected back (e.g. delivered as an
 * email attachment) — exfiltrate the internal response.
 *
 * Node runtime only (`dns`/`net`). This was previously inlined in
 * `webhooks/delivery.ts`; it now lives here so every fetch site shares one
 * blocklist.
 */

import { promises as dns, lookup as dnsLookup } from 'dns';
import { isIP } from 'net';
import type { LookupAddress, LookupAllOptions } from 'dns';
import { Agent } from 'undici';
import { readStreamBytes, StreamByteLimitExceeded } from '@owlat/shared';

// The literal-IP classification lives in the runtime-agnostic lib/ipBlocklist so
// the v8-runtime webhook-host check can share it. Re-exported for existing
// importers of ssrfGuard.
import { isDisallowedIpAddress } from './ipBlocklist';
export { isDisallowedIpAddress } from './ipBlocklist';

/**
 * Why {@link validatePublicUrl} rejected a URL. A machine-readable discriminant
 * so callers switch on the REASON rather than matching the operator-facing
 * `error` text (which is free to be reworded).
 *   - `invalid_format` — not a parseable URL.
 *   - `protocol`       — the scheme is not in the allowed set.
 *   - `missing_host`   — no hostname.
 *   - `blocked_address`— resolves to a private/internal/loopback address (SSRF).
 *   - `resolve_failed` — DNS resolution errored.
 *   - `no_address`     — DNS resolved to no addresses.
 */
export type UrlRejectionCode =
	| 'invalid_format'
	| 'protocol'
	| 'missing_host'
	| 'blocked_address'
	| 'resolve_failed'
	| 'no_address';

export type ValidatedUrl =
	| { ok: true; url: URL }
	| { ok: false; error: string; code: UrlRejectionCode };

/**
 * Parse + validate a user-supplied URL for safe server-side fetching: enforces
 * the allowed protocol(s) and rejects any host (literal IP or a DNS name where
 * ANY resolved A/AAAA record) that maps to a private/loopback/link-local
 * address.
 *
 * @param protocols allowed URL protocols (default http + https).
 */
export async function validatePublicUrl(
	urlStr: string,
	opts: { protocols?: string[] } = {}
): Promise<ValidatedUrl> {
	const protocols = opts.protocols ?? ['http:', 'https:'];

	let parsed: URL;
	try {
		parsed = new URL(urlStr);
	} catch {
		return { ok: false, error: 'Invalid URL format', code: 'invalid_format' };
	}

	if (!protocols.includes(parsed.protocol)) {
		return {
			ok: false,
			error: `URL must use ${protocols.join('/')} protocol`,
			code: 'protocol',
		};
	}

	const hostname = parsed.hostname;
	if (!hostname) {
		return { ok: false, error: 'URL hostname is missing', code: 'missing_host' };
	}

	if (isIP(hostname)) {
		if (isDisallowedIpAddress(hostname)) {
			return {
				ok: false,
				error: 'URL resolves to a disallowed (private/internal) IP address',
				code: 'blocked_address',
			};
		}
		return { ok: true, url: parsed };
	}

	let records: LookupAddress[];
	try {
		records = await dns.lookup(hostname, { all: true, verbatim: true });
	} catch {
		return { ok: false, error: 'Failed to resolve URL hostname', code: 'resolve_failed' };
	}

	if (records.length === 0) {
		return {
			ok: false,
			error: 'URL hostname did not resolve to any address',
			code: 'no_address',
		};
	}

	for (const record of records) {
		if (isDisallowedIpAddress(record.address)) {
			return {
				ok: false,
				error: 'URL resolves to a disallowed (private/internal) IP address',
				code: 'blocked_address',
			};
		}
	}

	return { ok: true, url: parsed };
}

/**
 * Underlying DNS resolver shape used by {@link ssrfLookup}, matching the
 * `dns.lookup` callback form with `{ all: true }`. Injectable so the hook can
 * be unit-tested without real DNS.
 */
export type LookupFn = (
	hostname: string,
	options: LookupAllOptions,
	callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void
) => void;

/**
 * A `dns.lookup`-shaped hook for `undici`'s `Agent` `connect.lookup`: it
 * resolves the hostname like the platform resolver but rejects the connection
 * if ANY returned address is private/loopback/link-local. This is the
 * connect-time defence against DNS rebinding (TOCTOU): the up-front
 * {@link validatePublicUrl} check resolves once, but the socket re-resolves
 * independently, so a name that flips to a private IP between the two would
 * otherwise slip through. By validating at the actual lookup the socket uses,
 * the connection can never be made to a disallowed address.
 *
 * `undici` always calls this with `{ all: true }`, so the callback receives the
 * full address list.
 */
export function ssrfLookup(
	hostname: string,
	options: LookupAllOptions,
	callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
	resolver: LookupFn = dnsLookup as unknown as LookupFn
): void {
	resolver(hostname, { ...options, all: true }, (err, addresses) => {
		if (err) {
			callback(err, addresses);
			return;
		}
		const list = Array.isArray(addresses) ? addresses : [];
		for (const record of list) {
			if (isDisallowedIpAddress(record.address)) {
				callback(
					new Error(
						`Blocked connect to "${hostname}": resolves to a disallowed (private/internal) IP address ${record.address}`
					),
					[]
				);
				return;
			}
		}
		callback(null, list);
	});
}

/**
 * An `undici` dispatcher whose socket-level DNS lookup runs every resolved
 * address through {@link ssrfLookup}. Pass as `fetch`'s `dispatcher` (an
 * undici-specific option, valid in the Node action runtime) so the connect-time
 * check binds to the exact addresses the socket will use. Use this for fetch
 * sites that need their own response handling (e.g. webhook delivery captures
 * non-2xx status/body) and so can't go through {@link fetchGuarded}; they must
 * still call {@link validatePublicUrl} for the up-front check.
 */
export function guardedDispatcher(): Agent {
	return new Agent({
		connect: {
			lookup: (hostname, options, callback) =>
				ssrfLookup(hostname, options as LookupAllOptions, callback),
		},
	});
}

/** Thrown by {@link readCappedBytes} when a response body exceeds the cap. */
export class CappedReadOverflow extends Error {}

/**
 * Read a response body stream up to `maxBytes` real octets, returning the
 * collected bytes (or `null` when there is no body). Throws
 * {@link CappedReadOverflow} the moment the stream exceeds the cap — the caller
 * decides whether that is a hard rejection (discovery treats an over-cap key
 * fetch as an SSRF violation) or a soft "too big, ignore" (MTA-STS returns
 * null). Counts actual octets (not UTF-16 code units) so multibyte bodies are
 * bounded correctly.
 */
export async function readCappedBytes(
	body: ReadableStream<Uint8Array> | null,
	maxBytes: number
): Promise<Uint8Array | null> {
	try {
		return await readStreamBytes(body, maxBytes);
	} catch (error) {
		if (error instanceof StreamByteLimitExceeded) {
			throw new CappedReadOverflow(error.message);
		}
		throw error;
	}
}

/**
 * Base class for {@link fetchGuarded}'s own refusals. Lets a caller classify a
 * blocked fetch by TYPE (`instanceof`) instead of matching the thrown message
 * text — the message is operator-facing wording and free to change, whereas the
 * type is a stable contract. A plain network error (DNS/socket failure) is NOT
 * an instance of this class, so `unreachable`-style fallbacks still catch it.
 */
export class FetchGuardError extends Error {}

/**
 * The destination is on the SSRF blocklist — it resolved to a private, internal,
 * loopback or link-local address. Thrown from the up-front {@link validatePublicUrl}
 * check (the connect-time re-resolution surfaces as a plain network error).
 */
export class SsrfBlockedError extends FetchGuardError {}

/** The destination answered with a 3xx redirect, which the guard refuses to follow. */
export class RedirectRefusedError extends FetchGuardError {}

/**
 * Fetch a user-supplied URL with SSRF protection:
 *   1. validate the destination against the private/internal blocklist;
 *   2. re-validate the resolved address(es) at CONNECT time via a custom
 *      `undici` `Agent` lookup hook ({@link ssrfLookup}) — closes the
 *      DNS-rebinding TOCTOU window where a name passes the up-front check then
 *      flips to a private IP before the socket independently re-resolves it;
 *   3. fetch with `redirect: 'manual'` and REJECT any 3xx — otherwise an
 *      attacker-controlled public host could 30x-redirect to an internal
 *      target, defeating the up-front check (the redirect-bypass).
 *
 * Throws on a disallowed destination, a redirect, or a network error.
 */
export async function fetchGuarded(
	urlStr: string,
	init: RequestInit & { protocols?: string[] } = {}
): Promise<Response> {
	const { protocols, ...requestInit } = init;
	const check = await validatePublicUrl(urlStr, { protocols });
	if (!check.ok) {
		const message = `Blocked fetch of "${urlStr}": ${check.error}`;
		throw check.code === 'blocked_address'
			? new SsrfBlockedError(message)
			: new FetchGuardError(message);
	}
	const res = await fetch(urlStr, {
		...requestInit,
		redirect: 'manual',
		// @ts-expect-error `dispatcher` is an undici-specific fetch option not in
		// the DOM RequestInit lib types, but valid in the Node runtime.
		dispatcher: guardedDispatcher(),
	});
	if (res.status >= 300 && res.status < 400) {
		throw new RedirectRefusedError(
			`Blocked fetch of "${urlStr}": refusing to follow redirect (to ${res.headers.get('location') ?? 'unknown'}) — possible SSRF`
		);
	}
	return res;
}
