/**
 * IP address literals in ONE canonical spelling each.
 *
 * A subject is keyed off the signed string, so every spelling of an address is
 * a separate reputation history. `2001:db8::1`, `2001:0db8:0000:0000:0000:0000:
 * 0000:0001` and `2001:db8:0:0:1::` all denote one host; accepting more than
 * one of them would let a hostile — or merely sloppy — observer fragment that
 * host's record at will. IPv4 rejects leading zeros for the same reason (and
 * because `010.0.0.1` is octal to some resolvers and decimal to others), IPv6
 * requires RFC 5952 presentation form.
 */

/** Dotted-quad IPv4, no leading zeros. */
export function isIpv4(value: unknown): value is string {
	if (typeof value !== 'string') return false;
	const octets = value.split('.');
	if (octets.length !== 4) return false;
	return octets.every((octet) => /^(?:0|[1-9][0-9]{0,2})$/.test(octet) && Number(octet) <= 255);
}

const IPV6_GROUP = /^[0-9a-f]{1,4}$/;
const IPV6_GROUPS = 8;
/** IPv4-mapped addresses (`::ffff:0:0/96`) keep a dotted-quad tail (RFC 5952 §5). */
const IPV4_MAPPED_MARKER = 0xffff;

/**
 * One colon-separated run of groups as 16-bit values, or null if any group is
 * not 1-4 lowercase hex digits. `allowIpv4` permits a trailing dotted quad,
 * which occupies the last two groups; it is only ever the final run.
 */
function parseGroupRun(text: string, allowIpv4: boolean): number[] | null {
	if (text === '') return [];
	const parts = text.split(':');
	const groups: number[] = [];
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i] ?? '';
		if (allowIpv4 && i === parts.length - 1 && part.includes('.')) {
			if (!isIpv4(part)) return null;
			const octets = part.split('.').map(Number);
			groups.push(
				((octets[0] ?? 0) << 8) | (octets[1] ?? 0),
				((octets[2] ?? 0) << 8) | (octets[3] ?? 0)
			);
			return groups;
		}
		if (!IPV6_GROUP.test(part)) return null;
		groups.push(Number.parseInt(part, 16));
	}
	return groups;
}

/**
 * The 16 bytes an IPv6 literal denotes, as eight 16-bit groups, or null if the
 * text is not an IPv6 address in ANY spelling. Canonicality is decided by
 * re-rendering, not here.
 */
export function parseIpv6Groups(value: string): number[] | null {
	const halves = value.split('::');
	if (halves.length > 2) return null;
	if (halves.length === 1) {
		const groups = parseGroupRun(halves[0] ?? '', true);
		return groups !== null && groups.length === IPV6_GROUPS ? groups : null;
	}
	const head = parseGroupRun(halves[0] ?? '', false);
	const tail = parseGroupRun(halves[1] ?? '', true);
	if (head === null || tail === null) return null;
	// `::` must stand for at least one group: eight explicit groups plus a `::`
	// is not a shorter spelling of anything.
	const compressed = IPV6_GROUPS - head.length - tail.length;
	if (compressed < 1) return null;
	return [...head, ...Array.from({ length: compressed }, () => 0), ...tail];
}

/** Start and length of the leftmost longest zero run in `groups[0, width)`. */
function longestZeroRun(groups: readonly number[], width: number): [number, number] {
	let bestStart = -1;
	let bestLength = 0;
	let start = -1;
	for (let i = 0; i < width; i++) {
		if (groups[i] !== 0) {
			start = -1;
			continue;
		}
		if (start < 0) start = i;
		if (i - start + 1 > bestLength) {
			bestStart = start;
			bestLength = i - start + 1;
		}
	}
	return [bestStart, bestLength];
}

/**
 * RFC 5952 presentation form: lowercase, no leading zeros in a group, `::` for
 * the leftmost longest run of at least TWO zero groups and nowhere else, and a
 * dotted-quad tail only for IPv4-mapped addresses.
 */
function renderIpv6(groups: readonly number[]): string {
	const mapped =
		groups.slice(0, 5).every((group) => group === 0) && groups[5] === IPV4_MAPPED_MARKER;
	const width = mapped ? 6 : IPV6_GROUPS;
	const [runStart, runLength] = longestZeroRun(groups, width);
	const parts: string[] = [];
	for (let i = 0; i < width; i++) {
		if (runLength >= 2 && i === runStart) {
			parts.push('');
			i += runLength - 1;
			continue;
		}
		parts.push((groups[i] ?? 0).toString(16));
	}
	let text = parts.join(':');
	// A run touching either end leaves one side of the `::` empty.
	if (runLength >= 2) {
		if (runStart === 0) text = `:${text}`;
		if (runStart + runLength === width) text = `${text}:`;
	}
	if (mapped) {
		const high = groups[6] ?? 0;
		const low = groups[7] ?? 0;
		text += `:${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
	}
	return text;
}

/**
 * IPv6 in RFC 5952 canonical presentation form. Every other spelling of the
 * same address is rejected rather than folded (see the file header), including
 * uppercase hex, expanded zero groups, a `::` compressing a single group, and a
 * dotted-quad tail on anything but an IPv4-mapped address.
 */
export function isIpv6(value: unknown): value is string {
	if (typeof value !== 'string') return false;
	const groups = parseIpv6Groups(value);
	return groups !== null && renderIpv6(groups) === value;
}

/** An IPv4 or canonical IPv6 address literal. */
export function isIpAddress(value: unknown): value is string {
	return isIpv4(value) || isIpv6(value);
}
