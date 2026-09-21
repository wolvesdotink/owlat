/**
 * SSRF guard shared by the setup validators.
 *
 * `validatePostHogHost` (`./setupValidators`) and `validateSmtpRelay`
 * (`./setupSmtpRelayValidator`) both fire a server-side connection at a
 * caller-supplied host, so both need the same "is this target public?" answer —
 * it lives here so the two can never drift apart on what counts as internal.
 *
 * Node-only (`node:dns`) and deliberately NOT re-exported from the browser-safe
 * `@owlat/shared` barrel: it is reached only through the server-side setup
 * validators (the Nitro setup endpoint and the CLI).
 */

import { lookup } from 'node:dns/promises';

/**
 * Block hosts that resolve to private, loopback, link-local, or cloud-metadata
 * addresses. `validatePostHogHost` fires a server-side request to a
 * caller-supplied host, so without this guard the setup endpoint is an SSRF
 * gadget for probing internal services (e.g. http://169.254.169.254/,
 * http://127.0.0.1:6379/). Hostname-literal check only — it stops the direct
 * IP-literal SSRF; DNS-rebinding to a public name is out of scope here, which is
 * why the endpoint should also remain behind the setup-token gate.
 */
export function isBlockedSsrfHost(hostname: string): boolean {
	const h = hostname.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets
	if (
		h === 'localhost' ||
		h.endsWith('.localhost') ||
		h.endsWith('.local') ||
		h.endsWith('.internal')
	) {
		return true;
	}
	const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (v4) {
		const o = v4.slice(1).map(Number);
		if (o.some((n) => n > 255)) return true; // malformed → block
		const [a, b] = o as [number, number, number, number];
		if (a === 0 || a === 127 || a === 10) return true;
		if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
		if (a === 172 && b >= 16 && b <= 31) return true;
		if (a === 192 && b === 168) return true;
		if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
		return false;
	}
	if (h.includes(':')) {
		// IPv6 literal
		if (h === '::1' || h === '::') return true;
		if (h.startsWith('fe80') || h.startsWith('fc') || h.startsWith('fd')) return true;
		if (h.startsWith('::ffff:')) return true; // IPv4-mapped — conservatively block
		return false;
	}
	return false;
}

/**
 * Best-effort DNS re-check on top of the literal `isBlockedSsrfHost` guard: a
 * PUBLIC name (which passes the literal check) can still resolve to an INTERNAL
 * address, the classic public-name → internal-IP SSRF. Resolve the host and
 * block if ANY resolved address lands in a private/loopback/link-local range —
 * reusing `isBlockedSsrfHost`, which already classifies IP literals.
 *
 * NON-BREAKING BY DESIGN: a resolution failure is NOT treated as blocked (the
 * subsequent probe fails on its own), so a transient DNS hiccup never turns a
 * legitimate public host into a false SSRF rejection. This is best-effort — it
 * narrows, but does not close, the DNS-rebinding window between this lookup and
 * the actual connect; the setup-token gate remains the primary control.
 */
export async function resolvesToBlockedAddress(hostname: string): Promise<boolean> {
	const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
	// A literal IP was already fully classified by `isBlockedSsrfHost`; nothing to
	// resolve, and `lookup` on an IP just echoes it back.
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':')) return false;
	try {
		const results = await lookup(h, { all: true });
		return results.some((r) => isBlockedSsrfHost(r.address));
	} catch {
		return false;
	}
}
