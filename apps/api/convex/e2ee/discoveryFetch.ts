'use node';

/**
 * The SSRF-guarded transport of recipient-key discovery (`e2ee/discovery.ts`) —
 * URL construction plus the one guarded HTTPS GET both discovery fetches
 * (`/.well-known/owlat.json` and the WKD direct method) go through.
 *
 * SSRF DISCIPLINE (copied from the MTA-STS verifier `domains/mtaStsVerify.ts`):
 * HTTPS only, public-unicast hosts only (every resolved address run through the
 * shared `isDisallowedIpAddress` blocklist), NO cross-host redirects (any 3xx
 * rejected), a bounded timeout, and a streamed size cap. Fetch + DNS are
 * injected via {@link DiscoveryDeps} so the whole path is unit-testable without
 * a network.
 */

import dns from 'node:dns/promises';
import { isDisallowedIpAddress } from '../lib/ipBlocklist';
import { readCappedBytes, CappedReadOverflow, guardedDispatcher } from '../lib/ssrfGuard';

/** Hard ceiling on a discovery fetch (mirrors the MTA-STS verify timeout). */
const FETCH_TIMEOUT_MS = 10_000;
/** A manifest / transferable public key is small; cap the read to bound memory. */
const MAX_BYTES = 256 * 1024;

/** Thrown when a fetch is rejected for an SSRF reason (non-https, redirect, private host, oversize). */
export class SsrfRejection extends Error {}

/** Injected DNS + HTTPS primitives so discovery is testable without a network. */
export interface DiscoveryDeps {
	/** Resolve every address for a host (per `node:dns` `lookup({ all: true })`). */
	lookup(host: string): Promise<{ address: string }[]>;
	/** Fetch a URL — structural (not `typeof fetch`), matching the MTA-STS deps shape. */
	fetch(input: string, init?: RequestInit): Promise<Response>;
}

export const defaultDeps: DiscoveryDeps = {
	lookup: (host) => dns.lookup(host, { all: true }),
	fetch: (input, init) =>
		fetch(input, {
			...init,
			// @ts-expect-error `dispatcher` is an undici-specific fetch option not in
			// the DOM RequestInit lib types, but valid in the Node action runtime. It
			// binds the socket-level DNS lookup to the SSRF blocklist, closing the
			// connect-time DNS-rebinding TOCTOU the up-front resolve can't (recipient
			// domains are attacker-influenceable — anyone you mail).
			dispatcher: guardedDispatcher(),
		}),
};

/** The manifest URL for a domain. */
export function buildManifestUrl(domain: string): string {
	return `https://${domain.toLowerCase()}/.well-known/owlat.json`;
}

/** The WKD direct-method URL for an address (matches how Owlat publishes). */
export function buildWkdUrl(domain: string, localPart: string, wkdHash: string): string {
	return `https://${domain.toLowerCase()}/.well-known/openpgpkey/hu/${wkdHash}?l=${encodeURIComponent(localPart)}`;
}

/**
 * SSRF-guarded HTTPS GET returning the raw body bytes, or `null` when the
 * resource legitimately isn't there (404 / non-2xx / empty resolution).
 * THROWS {@link SsrfRejection} on a security violation (non-https, a redirect,
 * a host that resolves to a private/link-local/loopback address, or an
 * over-cap body) so those are never silently treated as "no key".
 */
export async function guardedFetchBytes(
	urlStr: string,
	deps: DiscoveryDeps = defaultDeps
): Promise<Uint8Array | null> {
	let url: URL;
	try {
		url = new URL(urlStr);
	} catch {
		throw new SsrfRejection(`invalid URL: ${urlStr}`);
	}
	// HTTPS only — a plain-http target (or an http redirect) can't be trusted.
	if (url.protocol !== 'https:') {
		throw new SsrfRejection(`refusing non-https URL: ${urlStr}`);
	}
	// Resolve the host and reject if ANY address is private/link-local/loopback.
	// Best-effort (the socket re-resolves independently), narrowing the common
	// misconfig/abuse case exactly like the MTA-STS verifier.
	let addresses: { address: string }[];
	try {
		addresses = await deps.lookup(url.hostname);
	} catch {
		return null; // unresolvable host — nothing to fetch (negative), not an attack.
	}
	if (addresses.length === 0) return null;
	if (addresses.some((a) => isDisallowedIpAddress(a.address))) {
		throw new SsrfRejection(
			`host ${url.hostname} resolves to a disallowed (private/internal) address`
		);
	}

	const res = await deps.fetch(urlStr, {
		redirect: 'manual',
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	// Reject ALL redirects — an attacker-controlled public host could 30x to an
	// internal target, defeating the up-front check.
	if (res.status >= 300 && res.status < 400) {
		throw new SsrfRejection(`refusing to follow redirect from ${urlStr}`);
	}
	if (res.status === 404) return null;
	if (!res.ok) return null;

	// Reject an over-cap Content-Length, then enforce the cap while streaming too.
	const declared = Number(res.headers.get('content-length'));
	if (Number.isFinite(declared) && declared > MAX_BYTES) {
		throw new SsrfRejection(`response from ${urlStr} exceeds ${MAX_BYTES} bytes`);
	}
	// An over-cap streamed body is an SSRF-class rejection here (never silently a
	// "no key"): translate the shared reader's overflow into an SsrfRejection.
	try {
		return await readCappedBytes(res.body, MAX_BYTES);
	} catch (err) {
		if (err instanceof CappedReadOverflow) {
			throw new SsrfRejection(`response from ${urlStr} exceeds ${MAX_BYTES} bytes`);
		}
		throw err;
	}
}
