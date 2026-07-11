/**
 * Deterministic pre-send reference monitor for the AUTONOMOUS reply path.
 *
 * Auto-send is the textbook lethal-trifecta case: an untrusted inbound email
 * drives an LLM that produces a reply which then leaves the org boundary with
 * NO human in the loop. The classifier / draft self-check / injection + secret
 * scans in the `route` step are probabilistic defense-in-depth; this module is
 * the deterministic, NON-LLM backstop that runs immediately before the send
 * fires. It never calls a model. It enforces three invariants:
 *
 *   1. RECIPIENT LOCK — the outbound recipient is derived SERVER-SIDE from the
 *      authenticated inbound `From`. The model/draft can never supply, add, or
 *      redirect a recipient. We recompute the authenticated recipient here and
 *      assert the resolved send target equals it (no forwarding, no new To).
 *   2. LOCAL DLP — the draft is scanned for credential / OTP / 2FA / recovery-
 *      link fingerprints (see `lib/secretLeakScan.ts`). A hit means the reply
 *      would exfiltrate a secret or a one-time code unattended.
 *   3. OUTBOUND HTML SANITIZE — remote images / tracking pixels and off-
 *      allowlist link hosts are stripped from the outbound HTML so an auto-sent
 *      reply can't beacon or smuggle a link to an attacker-controlled host.
 *
 * FAIL-SOFT / FAIL-CLOSED: a recipient-lock or DLP violation returns
 * `{ ok: false, reason }` — the caller withholds the unattended send (the draft
 * is still produced + queued for human review; only the auto-send is withheld).
 * HTML sanitization is remediation, not a veto: it is applied in-place and the
 * (sanitized) send proceeds. This is a data-isolation backstop, not another
 * classifier — keep every check deterministic and cheap.
 */

import { normalizeEmail, parseAddress } from '@owlat/shared';
import { stripRemoteImages } from '@owlat/shared/postboxTrackers';
import { detectSecretLeak } from '../lib/secretLeakScan';

/**
 * Recompute the authenticated reply recipient from the inbound `From`. This is
 * the ONLY source of truth for the auto-send target — mirrors the send path's
 * own `extractRecipient` so the monitor and the sender agree by construction.
 * Returns undefined when nothing address-shaped is present.
 */
export function deriveAuthenticatedRecipient(inboundFrom: string): string | undefined {
	return parseAddress(inboundFrom)?.address;
}

export interface OutboundHtmlSanitizeResult {
	html: string;
	strippedRemoteImages: number;
	neutralizedLinks: number;
}

/**
 * Strip remote images / tracking pixels and neutralize off-allowlist link hosts
 * from outbound HTML. Deterministic string surgery — the agent draft is escaped
 * plain text today, so in practice there is nothing to strip; this is a hard
 * backstop in case a draft ever carries markup (e.g. a future rich draft or a
 * signature-adjacent fragment).
 *
 *   - Any `<img>` with a remote `src` (http/https/protocol-relative) is removed
 *     whole — that covers 1×1 tracking pixels and remote images alike.
 *   - Any `<a href>` whose host is not on `allowedHosts` has its `href` dropped
 *     (the visible text is preserved) so the link can't navigate off-allowlist.
 *
 * `allowedHosts` is compared case-insensitively; an empty allowlist neutralizes
 * every external link.
 */
export function sanitizeOutboundHtml(
	html: string,
	allowedHosts: readonly string[]
): OutboundHtmlSanitizeResult {
	const allowed = new Set<string>();
	for (const host of allowedHosts) {
		if (host) allowed.add(host.trim().toLowerCase());
	}

	let neutralizedLinks = 0;

	// Remove <img> tags whose src is remote (absolute http(s) or protocol-relative)
	// via the shared privacy-strip primitive so outbound + inbound neutralize
	// remote images identically (covers 1×1 tracking pixels and remote images).
	const { html: withoutRemoteImages, strippedRemoteImages } = stripRemoteImages(html);

	// Neutralize <a href="..."> whose host is not allow-listed: drop the href
	// attribute, keep the tag (and its inner text) intact.
	const sanitized = withoutRemoteImages.replace(
		/(<a\b[^>]*?)\bhref\s*=\s*(["'])([^"']*)\2([^>]*>)/gi,
		(match, pre: string, _quote: string, url: string, post: string) => {
			const host = linkHost(url);
			// Fragment / relative / mailto links have no external host — leave them.
			if (host === undefined) return match;
			if (allowed.has(host)) return match;
			neutralizedLinks += 1;
			return `${pre}${post}`;
		}
	);

	return { html: sanitized, strippedRemoteImages, neutralizedLinks };
}

/**
 * Extract the lowercased host of an href, or undefined for links with no
 * external host (relative paths, `#fragment`, `mailto:`, `tel:`). Off-allowlist
 * decisions only apply to links that actually navigate to a host.
 */
function linkHost(url: string): string | undefined {
	const trimmed = url.trim();
	if (trimmed === '' || trimmed.startsWith('#')) return undefined;
	const lower = trimmed.toLowerCase();
	if (lower.startsWith('mailto:') || lower.startsWith('tel:')) return undefined;
	// Protocol-relative or absolute URL: pull the authority.
	const m = /^(?:[a-z][a-z0-9+.-]*:)?\/\/([^/?#]+)/i.exec(trimmed);
	if (!m || !m[1]) return undefined; // relative path — same-origin, allowed.
	// Strip userinfo + port, lowercase the host.
	const authority = m[1];
	const hostPort = authority.includes('@')
		? authority.slice(authority.indexOf('@') + 1)
		: authority;
	const host = hostPort.includes(':') ? hostPort.slice(0, hostPort.indexOf(':')) : hostPort;
	return host.toLowerCase();
}

export interface ReferenceMonitorInput {
	/** Authenticated inbound `From` header ("Name <addr>" or bare addr). */
	inboundFrom: string;
	/** Recipient the send path resolved (must equal the derived authenticated one). */
	resolvedRecipient: string;
	/** Plain-text draft body (scanned for DLP fingerprints). */
	draftText: string;
	/** Final outbound HTML (sanitized in place). */
	draftHtml: string;
	/** Link hosts permitted in the outbound HTML (e.g. the org sending domain). */
	allowedLinkHosts: readonly string[];
}

export type ReferenceMonitorResult =
	| {
			ok: true;
			html: string;
			strippedRemoteImages: number;
			neutralizedLinks: number;
	  }
	| { ok: false; reason: string };

/**
 * Run the deterministic pre-send reference monitor. On a recipient-lock or DLP
 * violation returns `{ ok: false, reason }` (caller fails closed — withholds the
 * unattended send, routes to human review). Otherwise returns `{ ok: true }`
 * with the sanitized outbound HTML.
 */
export function runReferenceMonitor(input: ReferenceMonitorInput): ReferenceMonitorResult {
	// 1. Recipient lock — recompute the authenticated recipient server-side and
	//    require the resolved send target to match it exactly.
	const authenticated = deriveAuthenticatedRecipient(input.inboundFrom);
	if (!authenticated) {
		return {
			ok: false,
			reason:
				'Reference monitor: could not derive an authenticated recipient from the inbound sender; withholding auto-send.',
		};
	}
	if (normalizeEmail(input.resolvedRecipient) !== normalizeEmail(authenticated)) {
		return {
			ok: false,
			reason: `Reference monitor: resolved recipient does not match the authenticated inbound sender (${authenticated}); withholding auto-send.`,
		};
	}

	// 2. Local DLP — credential / OTP / 2FA / recovery-link fingerprints in the
	//    draft would exfiltrate a secret or one-time code unattended.
	const leak = detectSecretLeak(input.draftText);
	if (leak.detected) {
		return {
			ok: false,
			reason: `Reference monitor: outbound draft contains sensitive data (${leak.kind}); withholding auto-send.`,
		};
	}

	// 3. Outbound HTML sanitize — remediation, not a veto.
	const { html, strippedRemoteImages, neutralizedLinks } = sanitizeOutboundHtml(
		input.draftHtml,
		input.allowedLinkHosts
	);

	return { ok: true, html, strippedRemoteImages, neutralizedLinks };
}
