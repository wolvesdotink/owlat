/**
 * Canonical IP-address vocabulary shared by setup, DNS, and delivery code.
 *
 * Values cross environment-variable, URL, Redis-key, and DNS boundaries. Keep
 * parsing and canonicalization here so equivalent IPv6 spellings cannot become
 * different pool members or readiness records.
 */

export const IP_ADDRESS_FAMILIES = ['ipv4', 'ipv6'] as const;
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
