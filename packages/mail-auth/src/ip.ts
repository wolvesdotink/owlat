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

export interface SpfMacroContext {
	readonly sender?: string;
	readonly helo?: string;
}

/** Syntax failure in an SPF macro expression (RFC 7208 §7.4 → permerror). */
export class SpfMacroError extends Error {}

/**
 * Expand RFC 7208 §7 domain-spec macros, including digit, reverse, and custom
 * delimiter transformers. The validated-domain `%{p}` value follows the
 * established verifier behavior of using the sender domain when no separate
 * PTR-validation surface is available.
 */
export function expandMacros(
	input: string,
	senderIp: string,
	domain: string,
	context: SpfMacroContext = {}
): string {
	if (!input.includes('%')) return input;
	const sender = context.sender ?? domain;
	const at = sender.indexOf('@');
	const senderLocal = at === -1 ? '' : sender.slice(0, at);
	const senderDomain = at === -1 ? sender : sender.slice(at + 1);

	return input.replace(/%%|%_|%-|%\{([^}]+)\}|%/gi, (match, expression?: string) => {
		if (match === '%%') return '%';
		if (match === '%_') return ' ';
		if (match === '%-') return '%20';
		if (match === '%' || expression === undefined) {
			throw new SpfMacroError('Unexpected % in SPF macro');
		}

		const rawLetter = expression[0] ?? '';
		const letter = rawLetter.toLowerCase();
		const render = (expanded: string): string =>
			rawLetter === rawLetter.toUpperCase() ? encodeURIComponent(expanded) : expanded;
		let value: string;
		switch (letter) {
			case 's':
				value = sender;
				break;
			case 'l':
				value = senderLocal;
				break;
			case 'o':
				value = senderDomain;
				break;
			case 'p':
				// The PTR-validated domain of the connecting IP (RFC 7208 §7.3). We do
				// NOT perform the reverse-DNS validation `%{p}` requires, and the RFC
				// mandates the literal "unknown" whenever validation is not done —
				// expanding to the sender domain instead would let a crafted
				// `exists:%{p}...` record match without any reverse-DNS check.
				value = 'unknown';
				break;
			case 'd':
				value = domain;
				break;
			case 'i':
				value = macroIp(senderIp);
				break;
			case 'v':
				value = senderIp.includes(':') ? 'ip6' : 'in-addr';
				break;
			case 'h':
				value = context.helo ?? senderIp;
				break;
			default:
				throw new SpfMacroError(`Unknown SPF macro letter: ${letter ?? ''}`);
		}

		const transformer = expression.slice(1);
		const parsed = transformer.match(/^(\d+)?(r)?([.\-+,\x2f_=]*)$/i);
		if (!parsed) throw new SpfMacroError(`Invalid SPF macro transformer: ${expression}`);
		const partCount = parsed[1] === undefined ? undefined : Number(parsed[1]);
		if (partCount !== undefined && (!Number.isInteger(partCount) || partCount === 0)) {
			throw new SpfMacroError(`Invalid SPF macro part count: ${expression}`);
		}
		const delimiters = parsed[3] || '.';
		if (parsed[2] === undefined && partCount === undefined && delimiters === '.') {
			return render(value);
		}

		const escaped = delimiters.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		let parts = value.split(new RegExp(`[${escaped}]`));
		if (parsed[2] !== undefined) parts = parts.reverse();
		if (partCount !== undefined) parts = parts.slice(-partCount);
		return render(parts.join('.'));
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

	if (!network || isNaN(prefixLen) || prefixLen < 0 || prefixLen > 32) return false;

	const ipNum = ipToNumber(normalizedIp);
	const netNum = ipToNumber(network);

	if (ipNum === null || netNum === null) return false;

	const mask = prefixLen === 0 ? 0 : (~0 << (32 - prefixLen)) >>> 0;
	return (ipNum & mask) === (netNum & mask);
}

/** Validate an SPF `ip4:` value, including an optional 0..32 prefix. */
export function isValidIpv4Cidr(cidr: string): boolean {
	const parts = cidr.split('/');
	if (parts.length > 2 || ipToNumber(parts[0] ?? '') === null) return false;
	if (parts.length === 1) return true;
	return /^\d+$/.test(parts[1] ?? '') && Number(parts[1]) <= 32;
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

/** Validate an SPF `ip6:` value, including an optional 0..128 prefix. */
export function isValidIpv6Cidr(cidr: string): boolean {
	const parts = cidr.split('/');
	if (parts.length > 2 || expandIpv6(parts[0] ?? '') === null) return false;
	if (parts.length === 1) return true;
	return /^\d+$/.test(parts[1] ?? '') && Number(parts[1]) <= 128;
}
