/**
 * Literal-IP blocklist — pure string/regex classification with NO `dns`/`net`,
 * so it runs in BOTH the Convex v8 runtime (e.g. the webhook-endpoint mutation)
 * and `'use node'` actions (lib/ssrfGuard). It is the single source of truth for
 * "is this literal IP private / link-local / otherwise non-routable", so the
 * SSRF guard and the webhook-host check can't disagree.
 */

/**
 * True if `ip` is loopback, private (RFC 1918), link-local, CGNAT (RFC 6598),
 * unique-local IPv6, or otherwise not a routable public address.
 */
export function isDisallowedIpAddress(ip: string): boolean {
	const ipv4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (ipv4) {
		const a = Number(ipv4[1]);
		const b = Number(ipv4[2]);
		const octets = ipv4.slice(1).map(Number);
		if (octets.some((octet) => octet > 255)) return true;
		if (a === 0 || a === 10 || a === 127) return true;
		if (a === 169 && b === 254) return true;
		if (a === 172 && b >= 16 && b <= 31) return true;
		if (a === 192 && b === 168) return true;
		if (a === 100 && b >= 64 && b <= 127) return true;
		if (a >= 224) return true;
		return false;
	}

	const normalized = ip.toLowerCase();
	if (normalized === '::' || normalized === '::1') return true;
	if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
	if (
		normalized.startsWith('fe8') ||
		normalized.startsWith('fe9') ||
		normalized.startsWith('fea') ||
		normalized.startsWith('feb')
	) {
		return true;
	}
	if (normalized.startsWith('ff')) return true;
	if (normalized.startsWith('::ffff:')) {
		const mapped = normalized.slice('::ffff:'.length);
		// Dotted-quad form (::ffff:127.0.0.1) recurses directly.
		if (mapped.includes('.')) return isDisallowedIpAddress(mapped);
		// Hex form (::ffff:7f00:1 == 127.0.0.1) would otherwise fall through as
		// "public". Expand the two hextets into their four IPv4 bytes and
		// classify those.
		const groups = mapped.split(':');
		if (groups.length !== 2 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) {
			// Not a well-formed hex-mapped suffix — treat as disallowed rather
			// than risk classifying an unparseable address as public.
			return true;
		}
		const hi = parseInt(groups[0]!, 16);
		const lo = parseInt(groups[1]!, 16);
		const dotted = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
		return isDisallowedIpAddress(dotted);
	}
	return false;
}
