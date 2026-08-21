/**
 * Literal-IP blocklist — pure string/regex classification with NO `dns`/`net`,
 * so it runs in BOTH the Convex v8 runtime (e.g. the webhook-endpoint mutation)
 * and `'use node'` actions (lib/ssrfGuard). It is the single source of truth for
 * "is this literal IP private / link-local / otherwise non-routable", so the
 * SSRF guard and the webhook-host check can't disagree.
 */

/** One IPv6 hextet: 1-4 hex digits, already lower-cased by the caller. */
const HEXTET_PATTERN = /^[0-9a-f]{1,4}$/;
/** Dotted-quad IPv4, shared by the IPv4 branch and the IPv6 dotted tail. */
const DOTTED_QUAD_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * Expand an IPv6 literal into its eight 16-bit hextets, or `null` if it is not a
 * well-formed address.
 *
 * Classification MUST run on these numbers rather than on the input string:
 * 127.0.0.1 can be written `::ffff:7f00:1`, `0:0:0:0:0:ffff:127.0.0.1`,
 * `0::ffff:7f00:1`, `::ffff:0:7f00:1` or `::127.0.0.1`, and a prefix match on the
 * text catches only whichever spelling it was written against — every sibling
 * form then falls through as "public". Handles the `::` zero run and the
 * optional trailing dotted-quad; a `%eth0` zone id is rejected (it can only
 * appear on a link-local/multicast address, which the caller blocks anyway).
 */
function expandIpv6(address: string): number[] | null {
	const halves = address.split('::');
	if (halves.length > 2) return null; // at most one zero run

	const split = (part: string): string[] => (part === '' ? [] : part.split(':'));
	const compressed = halves.length === 2;

	// A dotted-quad tail is only legal as the very last group of the address.
	const parse = (parts: string[], dottedTailAllowed: boolean): number[] | null => {
		const hextets: number[] = [];
		for (let i = 0; i < parts.length; i++) {
			const part = parts[i]!;
			if (dottedTailAllowed && i === parts.length - 1 && part.includes('.')) {
				const quad = part.match(DOTTED_QUAD_PATTERN);
				if (!quad) return null;
				const octets = quad.slice(1).map(Number);
				if (octets.some((octet) => octet > 255)) return null;
				hextets.push((octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!);
				continue;
			}
			if (!HEXTET_PATTERN.test(part)) return null;
			hextets.push(parseInt(part, 16));
		}
		return hextets;
	};

	const head = parse(split(halves[0]!), !compressed);
	const tail = compressed ? parse(split(halves[1]!), true) : [];
	if (!head || !tail) return null;

	const supplied = head.length + tail.length;
	if (!compressed) return supplied === 8 ? head : null;
	// `::` stands for at least one zero group, so a compressed form can never
	// spell out all eight itself.
	if (supplied > 7) return null;
	return [...head, ...Array.from<number>({ length: 8 - supplied }).fill(0), ...tail];
}

/**
 * True if `ip` is loopback, private (RFC 1918), link-local, CGNAT (RFC 6598),
 * unique-local IPv6, or otherwise not a routable public address.
 */
export function isDisallowedIpAddress(ip: string): boolean {
	const ipv4 = ip.match(DOTTED_QUAD_PATTERN);
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
	// `new URL('http://[::1]/').hostname` keeps the brackets, and the webhook-host
	// check (webhooks/endpoints) feeds that hostname straight in with no `isIP()`
	// in front of it, so `[::ffff:7f00:1]` must not be mistaken for a DNS name.
	const literal =
		normalized.startsWith('[') && normalized.endsWith(']') ? normalized.slice(1, -1) : normalized;
	// A colon can never appear in a DNS name, so a colon-free string that reached
	// here is a hostname, not an address, and is not ours to classify.
	if (!literal.includes(':')) return false;

	const hextets = expandIpv6(literal);
	// Fail closed: an address we can't parse must never be reported as public.
	if (!hextets) return true;

	const first = hextets[0]!;
	const isZeroRange = (from: number, to: number): boolean =>
		hextets.slice(from, to).every((hextet) => hextet === 0);

	if (isZeroRange(0, 8)) return true; // :: (unspecified)
	if (isZeroRange(0, 7) && hextets[7] === 1) return true; // ::1 (loopback)
	if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
	if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
	if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast

	// Every form that embeds a real IPv4 destination in the low 32 bits is
	// classified by that IPv4, not by its prefix: ::ffff:a.b.c.d (v4-mapped),
	// ::ffff:0:a.b.c.d (RFC 2765 v4-translated), ::a.b.c.d (deprecated
	// v4-compatible) and 64:ff9b::a.b.c.d (RFC 6052 NAT64) all reach 127.0.0.1
	// or 169.254.169.254 on a host that speaks them.
	const embedsIpv4 =
		(isZeroRange(0, 5) && hextets[5] === 0xffff) ||
		(isZeroRange(0, 4) && hextets[4] === 0xffff && hextets[5] === 0) ||
		isZeroRange(0, 6) ||
		(first === 0x0064 && hextets[1] === 0xff9b && isZeroRange(2, 6));
	if (embedsIpv4) {
		const hi = hextets[6]!;
		const lo = hextets[7]!;
		const dotted = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
		return isDisallowedIpAddress(dotted);
	}

	return false;
}
