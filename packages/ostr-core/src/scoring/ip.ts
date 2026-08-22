/**
 * IP address handling for subject resolution (plan D2).
 *
 * Addresses are parsed to bytes and re-rendered canonically, so two spellings
 * of one IPv6 address (`2001:db8::1`, `2001:0db8:0:0:0:0:0:1`) are one subject
 * rather than two. Bare-IP evidence is grouped to a prefix — /32 for IPv4, /64
 * for IPv6 — because a single host conventionally owns a whole /64 and evidence
 * scattered across it must aggregate rather than dilute.
 *
 * No third-party dependency and no `node:net`: the grammar is small, and the
 * policy must behave identically in a non-Node implementation.
 */

/** A parsed address: 4 bytes for IPv4, 16 for IPv6. */
export interface ParsedIp {
	version: 4 | 6;
	bytes: number[];
}

/** A parsed CIDR range. `prefix` is in bits and is validated against the version. */
export interface ParsedCidr extends ParsedIp {
	prefix: number;
}

const IPV4_BYTES = 4;
const IPV6_BYTES = 16;
const IPV6_GROUPS = 8;
/** Default aggregation prefix per version (plan D2). */
const DEFAULT_PREFIX = { 4: 32, 6: 64 } as const;

const DECIMAL_OCTET = /^(?:0|[1-9]\d{0,2})$/;
const HEX_GROUP = /^[0-9a-f]{1,4}$/;

function parseIpv4(text: string): number[] | undefined {
	const parts = text.split('.');
	if (parts.length !== IPV4_BYTES) return undefined;
	const bytes: number[] = [];
	for (const part of parts) {
		// Leading zeros are rejected: `010` is octal in some resolvers and
		// decimal in others, and an ambiguous subject identifier is a bug.
		if (!DECIMAL_OCTET.test(part)) return undefined;
		const value = Number(part);
		if (value > 255) return undefined;
		bytes.push(value);
	}
	return bytes;
}

function pushGroup(bytes: number[], group: string): boolean {
	if (!HEX_GROUP.test(group)) return false;
	const value = Number.parseInt(group, 16);
	bytes.push(value >> 8, value & 0xff);
	return true;
}

function parseIpv6(text: string): number[] | undefined {
	const halves = text.split('::');
	if (halves.length > 2) return undefined;
	const head: number[] = [];
	const tail: number[] = [];
	const compressed = halves.length === 2;

	for (const [index, half] of halves.entries()) {
		const target = index === 0 ? head : tail;
		if (half === '') continue;
		const groups = half.split(':');
		for (const [position, group] of groups.entries()) {
			const last = position === groups.length - 1;
			if (last && group.includes('.')) {
				const embedded = parseIpv4(group);
				if (embedded === undefined) return undefined;
				target.push(...embedded);
				continue;
			}
			if (!pushGroup(target, group)) return undefined;
		}
	}

	const filled = head.length + tail.length;
	if (filled > IPV6_BYTES) return undefined;
	if (!compressed) return filled === IPV6_BYTES ? head : undefined;
	// `::` must stand for at least one zero group, or the address had a
	// redundant compression marker.
	if (filled > IPV6_BYTES - 2) return undefined;
	const zeros = Array.from({ length: IPV6_BYTES - filled }, () => 0);
	return [...head, ...zeros, ...tail];
}

/** Parse an IPv4 or IPv6 literal. Case-insensitive; surrounding space is trimmed. */
export function parseIp(text: string): ParsedIp | undefined {
	const trimmed = text.trim().toLowerCase();
	if (trimmed.length === 0) return undefined;
	if (trimmed.includes(':')) {
		const bytes = parseIpv6(trimmed);
		return bytes === undefined ? undefined : { version: 6, bytes };
	}
	const bytes = parseIpv4(trimmed);
	return bytes === undefined ? undefined : { version: 4, bytes };
}

/** Parse `address/prefix`. A bare address reads as its full-length prefix. */
export function parseCidr(text: string): ParsedCidr | undefined {
	const slash = text.indexOf('/');
	if (slash < 0) {
		const ip = parseIp(text);
		return ip === undefined ? undefined : { ...ip, prefix: ip.bytes.length * 8 };
	}
	const ip = parseIp(text.slice(0, slash));
	if (ip === undefined) return undefined;
	const suffix = text.slice(slash + 1).trim();
	if (!/^\d{1,3}$/.test(suffix)) return undefined;
	const prefix = Number(suffix);
	if (prefix > ip.bytes.length * 8) return undefined;
	return { ...ip, prefix };
}

/** Canonical text form: dotted quad for IPv4, RFC 5952 compressed lowercase for IPv6. */
export function formatIp(ip: ParsedIp): string {
	if (ip.version === 4) return ip.bytes.join('.');
	const groups: number[] = [];
	for (let i = 0; i < IPV6_GROUPS; i++) {
		groups.push(((ip.bytes[i * 2] as number) << 8) | (ip.bytes[i * 2 + 1] as number));
	}
	// RFC 5952 §4.2: compress the leftmost longest run of two or more zero groups.
	let runStart = -1;
	let runLength = 0;
	let bestStart = -1;
	let bestLength = 0;
	for (let i = 0; i < IPV6_GROUPS; i++) {
		if (groups[i] === 0) {
			if (runStart < 0) runStart = i;
			runLength++;
			if (runLength > bestLength) {
				bestLength = runLength;
				bestStart = runStart;
			}
		} else {
			runStart = -1;
			runLength = 0;
		}
	}
	const text = groups.map((group) => group.toString(16));
	if (bestLength < 2) return text.join(':');
	const head = text.slice(0, bestStart).join(':');
	const tail = text.slice(bestStart + bestLength).join(':');
	return `${head}::${tail}`;
}

/** Zero every bit below `prefix`. */
function maskTo(bytes: readonly number[], prefix: number): number[] {
	const masked: number[] = [];
	for (const [index, byte] of bytes.entries()) {
		const bitsBefore = index * 8;
		if (prefix >= bitsBefore + 8) masked.push(byte);
		else if (prefix <= bitsBefore) masked.push(0);
		else masked.push(byte & (0xff << (bitsBefore + 8 - prefix)) & 0xff);
	}
	return masked;
}

/** True when `ip` lies inside `range`. Versions must match. */
export function inRange(ip: ParsedIp, range: ParsedCidr): boolean {
	if (ip.version !== range.version) return false;
	const left = maskTo(ip.bytes, range.prefix);
	const right = maskTo(range.bytes, range.prefix);
	return left.every((byte, index) => byte === right[index]);
}

/**
 * The default aggregation key for bare-IP evidence: the /32 (IPv4) or /64
 * (IPv6) network the address sits in, rendered as CIDR text.
 */
export function defaultPrefixKey(ip: ParsedIp): string {
	const prefix = DEFAULT_PREFIX[ip.version];
	return `${formatIp({ version: ip.version, bytes: maskTo(ip.bytes, prefix) })}/${prefix}`;
}
