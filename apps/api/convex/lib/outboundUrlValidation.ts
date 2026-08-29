/**
 * Pure, isolate-safe (no `'use node'`) shape validation for an outbound URL that
 * the backend will fetch on behalf of a privileged caller (an AI-provider base
 * URL, a transactional-attachment URL, …).
 *
 * This is the WRITE-TIME / PRE-FETCH gate. Full DNS-time SSRF enforcement —
 * resolving the hostname and rejecting private/link-local addresses at connect
 * time, refusing redirects — is `lib/ssrfGuard`'s job in the Node runtime; this
 * module runs in both runtimes so persist mutations (v8) and the fetch sites can
 * share ONE rule and can't disagree. The literal-IP classification is delegated
 * to `lib/ipBlocklist` (the same source of truth ssrfGuard uses).
 */

import { isDisallowedIpAddress } from './ipBlocklist';

export type OutboundUrlCheck = { ok: true; url: URL } | { ok: false; error: string };

/**
 * Validate a caller-supplied outbound URL.
 *   - must be a parseable absolute URL with a hostname;
 *   - must use http or https (never `file:`/`gopher:`/…);
 *   - must not embed credentials (`user:pass@` can smuggle a secret to the host
 *     or confuse the fetch);
 *   - when `requirePublic` is set (any fetch that transmits a secret — e.g. a
 *     hosted provider key — or reflects the response body back to the caller):
 *     additionally require https and reject a hostname that is a LITERAL
 *     private/loopback/link-local IP. A keyless local endpoint (Ollama on
 *     `http://localhost`) sets `requirePublic: false` so it stays reachable.
 */
export function validateOutboundUrl(
	raw: string,
	opts: { requirePublic: boolean }
): OutboundUrlCheck {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return { ok: false, error: 'must be a valid absolute URL' };
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		return { ok: false, error: 'must use http or https' };
	}
	if (!url.hostname) {
		return { ok: false, error: 'must have a hostname' };
	}
	if (url.username || url.password) {
		return { ok: false, error: 'must not embed credentials' };
	}
	if (opts.requirePublic) {
		if (url.protocol !== 'https:') {
			return { ok: false, error: 'must use https' };
		}
		// `url.hostname` keeps the brackets on an IPv6 literal (`[::1]`), which
		// `isDisallowedIpAddress` handles; a DNS name classifies as public here and
		// is re-checked against its resolved addresses by ssrfGuard at fetch time.
		if (isDisallowedIpAddress(url.hostname)) {
			return { ok: false, error: 'must not point at a private or internal address' };
		}
	}
	return { ok: true, url };
}
