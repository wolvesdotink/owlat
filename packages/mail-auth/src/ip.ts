/**
 * Pure IP-address and RFC 7208 §7 macro helpers used by the SPF evaluator.
 *
 * Split out of `spf.ts` (logic frozen — a move, not a rewrite) so neither file
 * crosses the repo's ~500-LOC file-size ratchet. These functions are
 * side-effect-free string/number arithmetic (no DNS, no I/O).
 */

/** Strip the IPv4-mapped IPv6 prefix (`::ffff:`) so a host is keyed by its v4 form. */
export function normalizeIp(ip: string): string {
	if (ip.startsWith('::ffff:')) {
		return ip.slice(7);
	}
	return ip;
}

/** Alias of {@link normalizeIp}: strip the IPv4-mapped IPv6 prefix. */
export function stripIpv4Prefix(ip: string): string {
	if (ip.startsWith('::ffff:')) {
		return ip.slice(7);
	}
	return ip;
}

/**
 * Expand the subset of RFC 7208 §7 macros that affect host lookups.
 *
 * Supports `%{i}` (sender IP, dotted-quad for IPv4 / nibble form for IPv6),
 * `%{d}` (current domain), `%{o}`/`%{s}` (sender — we only know the domain part),
 * and the literals `%%`, `%_`, `%-`. Macro modifiers (digit transformers,
 * reversal, alternate delimiters) are intentionally not implemented; an
 * unrecognised macro is left verbatim so the resulting lookup simply misses
 * rather than throwing — adequate for the common `exists:%{i}...` idiom.
 */
export function expandMacros(input: string, senderIp: string, domain: string): string {
	if (!input.includes('%')) return input;
	return input.replace(/%\{([a-zA-Z])\}|%%|%_|%-/g, (match, letter?: string) => {
		if (match === '%%') return '%';
		if (match === '%_') return ' ';
		if (match === '%-') return '%20';
		switch ((letter ?? '').toLowerCase()) {
			case 'i':
				return macroIp(senderIp);
			case 'd':
				return domain;
			case 's':
			case 'o':
				return domain;
			default:
				return match;
		}
	});
}

/** Macro %{i} expansion: dotted-quad for IPv4, dot-separated nibbles for IPv6. */
function macroIp(ip: string): string {
	const v4 = stripIpv4Prefix(ip);
	if (/^\d+\.\d+\.\d+\.\d+$/.test(v4)) {
		return v4;
	}
	// IPv6: expand to 32 hex nibbles separated by dots (best-effort).
	const expanded = expandIpv6(ip);
	if (expanded) {
		return expanded.split('').join('.');
	}
	return ip;
}

/** Expand an IPv6 address to its 32-nibble hex string, or null if unparsable. */
function expandIpv6(ip: string): string | null {
	if (!ip.includes(':')) return null;
	const halves = ip.split('::');
	if (halves.length > 2) return null;
	const head = halves[0] ? halves[0]!.split(':') : [];
	const tail = halves.length === 2 ? (halves[1] ? halves[1]!.split(':') : []) : [];
	const missing = 8 - head.length - tail.length;
	if (missing < 0) return null;
	const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
	if (groups.length !== 8) return null;
	let out = '';
	for (const g of groups) {
		if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
		out += g.toLowerCase().padStart(4, '0');
	}
	return out;
}

/**
 * Check if an IP matches a CIDR range (IPv4 only)
 * Handles both plain IPs and CIDR notation (e.g., 10.0.0.0/24)
 */
export function ipMatchesCidr(ip: string, cidr: string): boolean {
	const normalizedIp = stripIpv4Prefix(ip);

	// Plain IP comparison
	if (!cidr.includes('/')) {
		return normalizedIp === cidr;
	}

	const [network, prefixLenStr] = cidr.split('/');
	const prefixLen = parseInt(prefixLenStr!, 10);

	if (!network || isNaN(prefixLen)) return false;

	const ipNum = ipToNumber(normalizedIp);
	const netNum = ipToNumber(network);

	if (ipNum === null || netNum === null) return false;

	const mask = prefixLen === 0 ? 0 : (~0 << (32 - prefixLen)) >>> 0;
	return (ipNum & mask) === (netNum & mask);
}

function ipToNumber(ip: string): number | null {
	const parts = ip.split('.');
	if (parts.length !== 4) return null;

	let result = 0;
	for (const part of parts) {
		const num = parseInt(part, 10);
		if (isNaN(num) || num < 0 || num > 255) return null;
		result = (result << 8) | num;
	}

	return result >>> 0;
}

/**
 * RFC 7208 §5.6: an `ip6:` mechanism may carry a CIDR prefix length, in which
 * case the connecting IP matches when its leading `prefixLen` bits equal the
 * network's. Without this, a sender covered by a legitimate `ip6:2001:db8::/32`
 * record (e.g. a large provider like Microsoft) is wrongly scored non-matching
 * because the old code only did an exact address comparison.
 *
 * Handles both a bare address (`2001:db8::1`, exact match) and a CIDR
 * (`2001:db8::/32`, prefix match). Returns false for any unparsable IPv6 input
 * or a prefix length outside 0–128.
 */
export function ipv6MatchesCidr(ip: string, cidr: string): boolean {
	const slash = cidr.indexOf('/');
	const network = slash === -1 ? cidr : cidr.slice(0, slash);
	const prefixLen = slash === -1 ? 128 : parseInt(cidr.slice(slash + 1), 10);
	if (isNaN(prefixLen) || prefixLen < 0 || prefixLen > 128) return false;

	const ipNibbles = expandIpv6(ip);
	const netNibbles = expandIpv6(network);
	if (ipNibbles === null || netNibbles === null) return false;

	// Both are 32-nibble (128-bit) hex strings. Compare the leading `prefixLen`
	// bits: whole nibbles first, then the partial nibble straddling the boundary.
	const fullNibbles = Math.floor(prefixLen / 4);
	if (ipNibbles.slice(0, fullNibbles) !== netNibbles.slice(0, fullNibbles)) {
		return false;
	}
	const remainingBits = prefixLen % 4;
	if (remainingBits === 0) return true;

	const mask = 0xf & (0xf << (4 - remainingBits));
	const ipNibble = parseInt(ipNibbles[fullNibbles]!, 16);
	const netNibble = parseInt(netNibbles[fullNibbles]!, 16);
	return (ipNibble & mask) === (netNibble & mask);
}
