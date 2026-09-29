/**
 * Canonical IP-address vocabulary shared by setup, DNS, and delivery code.
 *
 * Values cross environment-variable, URL, Redis-key, and DNS boundaries. Keep
 * parsing and canonicalization here so equivalent IPv6 spellings cannot become
 * different pool members or readiness records.
 */

const IP_ADDRESS_FAMILIES = ['ipv4', 'ipv6'] as const;
export type IpAddressFamily = (typeof IP_ADDRESS_FAMILIES)[number];

export interface ParsedIpAddress {
	address: string;
	family: IpAddressFamily;
}

function parseIpv4(input: string): ParsedIpAddress | null {
	const octets = input.split('.');
	if (octets.length !== 4) return null;
	const numbers: number[] = [];
	for (const octet of octets) {
		if (!/^(?:0|[1-9]\d{0,2})$/.test(octet)) return null;
		const number = Number(octet);
		if (number > 255) return null;
		numbers.push(number);
	}
	return { address: numbers.join('.'), family: 'ipv4' };
}

function parseIpv6(input: string): ParsedIpAddress | null {
	// Brackets belong to URI authority syntax, a zone id is not stable across
	// hosts/containers, and CIDR/port syntax is not a source address.
	if (
		!input.includes(':') ||
		input.includes('[') ||
		input.includes(']') ||
		input.includes('%') ||
		input.includes('/') ||
		/\s/.test(input)
	) {
		return null;
	}
	try {
		// The WHATWG host parser validates and RFC-5952-canonicalizes IPv6 in
		// browsers, Node, and Convex's V8 runtime without a Node-only dependency.
		const hostname = new URL(`http://[${input}]/`).hostname;
		if (!hostname.startsWith('[') || !hostname.endsWith(']')) return null;
		const address = hostname.slice(1, -1);
		return address.includes(':') ? { address, family: 'ipv6' } : null;
	} catch {
		return null;
	}
}

/** Parse one bare address. Surrounding whitespace is normalized; syntax is strict. */
export function parseIpAddress(value: string): ParsedIpAddress | null {
	const input = value.trim();
	if (!input) return null;
	return input.includes(':') ? parseIpv6(input) : parseIpv4(input);
}

export function normalizeIpAddress(value: string): string | null {
	return parseIpAddress(value)?.address ?? null;
}

export function ipAddressFamily(value: string): IpAddressFamily | null {
	return parseIpAddress(value)?.family ?? null;
}

/** Parse the deliberately explicit outbound-IPv6 feature gate. */
export function parseIpv6Enabled(value: string | undefined): boolean {
	const normalized = value?.trim() || 'false';
	if (normalized !== 'true' && normalized !== 'false') {
		throw new Error('MTA_IPV6_ENABLED must be true or false');
	}
	return normalized === 'true';
}

/** IPv4-mapped values are not native IPv6 source identities. */
export function isIpv4MappedIpv6(value: string): boolean {
	const parsed = parseIpAddress(value);
	return parsed?.family === 'ipv6' && parsed.address.startsWith('::ffff:');
}

const IPV4_MAPPED_PREFIX = '::ffff:';

/**
 * Strip an IPv4-mapped IPv6 prefix down to the dotted quad; return anything
 * else unchanged.
 *
 * A dual-stack listener (`::`) reports an IPv4 peer as `::ffff:10.0.0.1`, while
 * the WHATWG canonical form {@link parseIpAddress} produces is `::ffff:a00:1`;
 * both map to `10.0.0.1`. Native IPv6 is deliberately NOT canonicalized: the
 * result keys Redis connection slots and auth-failure counters, which must stay
 * byte-identical for every address a socket already reports.
 */
export function unmapIpv4(ip: string): string {
	if (ip.slice(0, IPV4_MAPPED_PREFIX.length).toLowerCase() !== IPV4_MAPPED_PREFIX) return ip;
	const tail = ip.slice(IPV4_MAPPED_PREFIX.length);
	if (parseIpv4(tail)) return tail;
	const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(tail);
	if (!hex) return ip;
	const high = Number.parseInt(hex[1]!, 16);
	const low = Number.parseInt(hex[2]!, 16);
	return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

/** The IPv4 octets of a native IPv4 or IPv4-mapped IPv6 address, else null. */
function ipv4Octets(parsed: ParsedIpAddress): number[] | null {
	const v4 = parsed.family === 'ipv4' ? parsed.address : unmapIpv4(parsed.address);
	return v4.includes(':') ? null : v4.split('.').map(Number);
}

/**
 * True for a loopback address: 127.0.0.0/8, `::1` in any spelling, and the
 * IPv4-mapped forms of 127/8. Anything that does not parse as a bare address
 * (a hostname, brackets, a port) is false.
 */
export function isLoopbackIp(ip: string): boolean {
	const parsed = parseIpAddress(ip);
	if (!parsed) return false;
	const octets = ipv4Octets(parsed);
	return octets ? octets[0] === 127 : parsed.address === '::1';
}

/**
 * True for loopback plus the RFC 1918 private ranges (10/8, 172.16/12,
 * 192.168/16), including their IPv4-mapped forms. IPv6 unique-local space
 * (fc00::/7) is deliberately out of scope: no deployment addresses internal
 * peers that way today, and an exemption is easier to widen than to take back.
 */
export function isPrivateOrLoopbackIp(ip: string): boolean {
	const parsed = parseIpAddress(ip);
	if (!parsed) return false;
	const octets = ipv4Octets(parsed);
	if (!octets) return parsed.address === '::1';
	const [first, second] = octets as [number, number];
	return (
		first === 127 ||
		first === 10 ||
		(first === 172 && second >= 16 && second <= 31) ||
		(first === 192 && second === 168)
	);
}

/**
 * True when a host name or literal names this machine: exactly `localhost`, or
 * a loopback IP literal ({@link isLoopbackIp}). Case, surrounding whitespace,
 * one trailing dot and URI brackets (`[::1]`) are ignored. Subdomains of
 * `localhost` are NOT accepted: this gates plaintext credentials and a
 * plain-http DNSSEC resolver, and no resolver is obliged to map
 * `anything.localhost` to loopback.
 */
export function isLoopbackHostname(host: string): boolean {
	let h = host.trim().toLowerCase();
	if (h.endsWith('.')) h = h.slice(0, -1);
	if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
	return h === 'localhost' || isLoopbackIp(h);
}

/** True unless an IPv6-capable pool lacks an IPv4 address for the same workload. */
export function hasIpv4FallbackForIpv6(addresses: readonly string[]): boolean {
	const families = new Set(addresses.map(ipAddressFamily).filter(Boolean));
	return !families.has('ipv6') || families.has('ipv4');
}

/**
 * Expand a canonical IPv6 address to its 32 hexadecimal nibbles.
 * Exported for DNS protocols that encode an address one nibble at a time.
 */
export function ipv6HexNibbles(value: string): string | null {
	const parsed = parseIpAddress(value);
	if (parsed?.family !== 'ipv6') return null;
	const halves = parsed.address.split('::');
	if (halves.length > 2) return null;
	const leftGroups = halves[0] ? halves[0].split(':') : [];
	const rightGroups = halves[1] ? halves[1].split(':') : [];
	const omittedGroups = 8 - leftGroups.length - rightGroups.length;
	if (omittedGroups < 0 || (halves.length === 1 && omittedGroups !== 0)) return null;
	const groups = [
		...leftGroups,
		...Array.from({ length: omittedGroups }, () => '0'),
		...rightGroups,
	];
	if (groups.length !== 8) return null;
	return groups.map((group) => group.padStart(4, '0')).join('');
}

/** DNSBL/ip6.arpa-style reversed-nibble form, without a zone suffix. */
export function reverseIpAddressForDns(value: string): string | null {
	const parsed = parseIpAddress(value);
	if (!parsed) return null;
	if (parsed.family === 'ipv4') return parsed.address.split('.').reverse().join('.');
	const nibbles = ipv6HexNibbles(parsed.address);
	return nibbles ? [...nibbles].reverse().join('.') : null;
}

/**
 * Canonical form of a connected peer's address: IPv4-mapped IPv6 unmapped to
 * the dotted quad, native IPv6 in RFC 5952 form. Null when the value is not a
 * bare address (for example the `'unknown'` placeholder).
 */
export function normalizePeerIp(ip: string): string | null {
	const parsed = parseIpAddress(unmapIpv4(ip.trim()));
	return parsed ? unmapIpv4(parsed.address) : null;
}

/**
 * The per-client key an IP-based limiter counts under. IPv4 (including the
 * IPv4-mapped forms) keys on the full address; IPv6 keys on its /64, written
 * `2001:db8:1:2::/64`, because a single host is routinely assigned a whole /64
 * and can pick a fresh source address from it for every connection. A value
 * that is not a bare address is returned unchanged, so a shared placeholder
 * such as `'unknown'` stays one bucket.
 */
export function ipRateLimitKey(ip: string): string {
	const peer = normalizePeerIp(ip);
	if (!peer) return ip;
	if (!peer.includes(':')) return peer;
	const nibbles = ipv6HexNibbles(peer);
	if (!nibbles) return peer;
	const prefixGroups = nibbles.slice(0, 16).match(/.{4}/g) ?? [];
	const prefix = normalizeIpAddress(`${prefixGroups.join(':')}::`);
	return prefix ? `${prefix}/64` : peer;
}
