/**
 * An AddressObject layer over a self-contained RFC 5322 mailbox primitive.
 *
 * `mail-message` is the in-house parser that replaces mailparser, so it owns
 * its own mailbox primitive rather than depending back on the foundational
 * `@owlat/shared` package — that keeps the workspace graph one-directional
 * (`shared` re-exports the header helpers *from* `mail-message`; nothing flows
 * back). On top of the single-mailbox parse this module adds what a message
 * parser needs: RFC 5322 group syntax (`Team: a@x, b@y;`), a decoded display
 * `name`, a `.text` reconstruction of the whole list, and the mailparser-style
 * single-header-vs-many-headers duality (`from` is one object, repeated `To:`
 * headers are an array).
 */

import { decodeHeaderValue } from './headers';

/** One parsed mailbox, or (when `group` is set) a group container. */
export interface EmailAddress {
	/** Display name, decoded through RFC 2047. Empty string when absent. */
	name: string;
	/** Mailbox address, lowercased. Empty string for a group container. */
	address: string;
	/** Members, present only when this entry is an RFC 5322 group. */
	group?: EmailAddress[];
}

/** The raw name/address of a single mailbox before RFC 2047 decoding. */
interface RawMailbox {
	name?: string;
	address: string;
}

/**
 * Defensive upper bound on the length of an address-header value handed to the
 * parser. Address headers (`To:`, `Cc:`, …) reach this parser straight off the
 * wire — the unauthenticated MX accepts a DATA body up to 10 MiB and nothing
 * upstream of `parse/` caps header size. A real RFC 5322 address-list header is
 * at most a few hundred bytes; anything past 16 KiB is already absurd. Capping
 * the input here keeps every scan in this module strictly bounded so a single
 * hostile header can never drive superlinear work (defense in depth even if a
 * future regex change reintroduces backtracking). Exceeding the cap degrades
 * gracefully — we parse the leading 16 KiB and drop the rest — and NEVER
 * throws, honoring the parser's never-throws/bounded contract.
 */
export const MAX_ADDRESS_HEADER_LENGTH = 16 * 1024;

/**
 * Parse one mailbox token. Accepts `email@host`, `<email@host>`, or
 * `"Name" <email@host>` / `Name <email@host>`; returns `null` when no
 * `local@domain` can be extracted. Address is lowercased; a surrounding pair
 * of quotes is stripped from the display name (RFC 2047 decoding happens in
 * {@link toEmailAddress}).
 *
 * The display-name / angle-addr split is performed with plain index scans
 * (`lastIndexOf`/`indexOf`) rather than a regex: the previous anchored pattern
 * `/^(.*?)<\s*([^>]+?)\s*>\s*$/` backtracked catastrophically (O(n^2)) on a
 * long run of `<` with no closing `>`, so a crafted address header could pin a
 * core for minutes. This scan is O(n) and produces identical results for every
 * valid input (verified against the differential mailparser oracle).
 */
function parseMailbox(input: string): RawMailbox | null {
	const trimmed = input.trim();
	if (!trimmed) return null;
	// Angle-addr form: `[display] <addr>`. The old lazy regex chose the LEFTMOST
	// `<` whose content reached a trailing `>` at end-of-string with no `>` in
	// between. Reproduce that in linear time: the terminal `>` is the last char
	// (input is trimmed), the opening `<` is the first `<` after the previous
	// `>` (so the angle content holds no `>`), and empty content means "no angle
	// match" — fall through to the bare-address scan exactly as the regex did.
	if (trimmed.endsWith('>')) {
		const finalGt = trimmed.length - 1;
		const prevGt = trimmed.lastIndexOf('>', finalGt - 1);
		const openLt = trimmed.indexOf('<', prevGt + 1);
		if (openLt !== -1 && openLt < finalGt) {
			const content = trimmed.slice(openLt + 1, finalGt).trim();
			if (content !== '') {
				const rawName = trimmed
					.slice(0, openLt)
					.trim()
					.replace(/^"(.*)"$/, '$1');
				const address = content.toLowerCase();
				if (!address.includes('@')) return null;
				return { name: rawName || undefined, address };
			}
		}
	}
	const bareMatch = trimmed.match(/([^\s<>]+@[^\s<>]+)/);
	if (!bareMatch || bareMatch[1] === undefined) return null;
	return { address: bareMatch[1].toLowerCase() };
}

/** The parsed contents of one address header. */
export interface AddressObject {
	/** Top-level mailboxes and groups in document order. */
	value: EmailAddress[];
	/** A canonical reconstruction of the list (`"Doe, John" <j@x>, b@y`). */
	text: string;
}

const NAME_NEEDS_QUOTING = /[()<>[\]:;@\\",.]/;

function toEmailAddress(raw: string): EmailAddress | null {
	const parsed = parseMailbox(raw);
	if (!parsed) return null;
	return {
		name: parsed.name === undefined ? '' : decodeHeaderValue(parsed.name),
		address: parsed.address,
	};
}

/**
 * Split an address-list header into its top-level mailboxes and groups,
 * honoring quoted strings, angle brackets, and `name: … ;` group syntax so a
 * comma inside any of those does not split the list.
 */
export function parseAddressList(input: string): EmailAddress[] {
	// Defensive bound: never scan more than MAX_ADDRESS_HEADER_LENGTH bytes of a
	// single address header. A legitimate header is orders of magnitude shorter;
	// truncating a hostile one keeps this loop (and every per-token parse it
	// drives) linear and bounded. Degrade gracefully — parse what fits, drop the
	// rest — rather than throw, per the never-throws contract.
	if (input.length > MAX_ADDRESS_HEADER_LENGTH) {
		input = input.slice(0, MAX_ADDRESS_HEADER_LENGTH);
	}
	const result: EmailAddress[] = [];
	let group: { name: string; members: EmailAddress[] } | null = null;
	let buf = '';
	let inQuote = false;
	let angle = 0;

	const flushInto = (target: EmailAddress[]): void => {
		if (buf.trim() === '') {
			buf = '';
			return;
		}
		const addr = toEmailAddress(buf);
		if (addr) target.push(addr);
		buf = '';
	};

	for (let i = 0; i < input.length; i++) {
		const ch = input[i]!;
		if (ch === '"') {
			inQuote = !inQuote;
			buf += ch;
			continue;
		}
		if (inQuote) {
			buf += ch;
			continue;
		}
		if (ch === '<') {
			angle += 1;
			buf += ch;
			continue;
		}
		if (ch === '>') {
			if (angle > 0) angle -= 1;
			buf += ch;
			continue;
		}
		if (angle > 0) {
			buf += ch;
			continue;
		}
		if (ch === ':' && group === null && !buf.includes('@')) {
			group = { name: decodeHeaderValue(buf.trim()), members: [] };
			buf = '';
			continue;
		}
		if (ch === ',') {
			flushInto(group ? group.members : result);
			continue;
		}
		if (ch === ';' && group !== null) {
			flushInto(group.members);
			result.push({ name: group.name, address: '', group: group.members });
			group = null;
			continue;
		}
		buf += ch;
	}

	if (group !== null) {
		flushInto(group.members);
		result.push({ name: group.name, address: '', group: group.members });
	} else {
		flushInto(result);
	}
	return result;
}

function quoteName(name: string): string {
	return NAME_NEEDS_QUOTING.test(name) ? `"${name.replace(/(["\\])/g, '\\$1')}"` : name;
}

/** Reconstruct one address (or group) into its canonical header form. */
export function formatAddress(addr: EmailAddress): string {
	if (addr.group !== undefined) {
		const members = addr.group.map(formatAddress).join(', ');
		return members === '' ? `${quoteName(addr.name)}:;` : `${quoteName(addr.name)}: ${members};`;
	}
	if (addr.name !== '') return `${quoteName(addr.name)} <${addr.address}>`;
	return addr.address;
}

/** Reconstruct a whole list into its canonical header form. */
export function formatAddressList(list: readonly EmailAddress[]): string {
	return list.map(formatAddress).join(', ');
}

/** Parse a single address header value into an {@link AddressObject}. */
export function parseAddressObject(value: string): AddressObject {
	const list = parseAddressList(value);
	return { value: list, text: formatAddressList(list) };
}

/**
 * Parse the values of one address header name. Mirrors mailparser's duality:
 * `undefined` when the header is absent, a single {@link AddressObject} when
 * present once, and an array when the header is repeated.
 */
export function parseAddressObjects(
	values: readonly string[]
): AddressObject | AddressObject[] | undefined {
	if (values.length === 0) return undefined;
	if (values.length === 1) return parseAddressObject(values[0]!);
	return values.map(parseAddressObject);
}
