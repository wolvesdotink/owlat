/**
 * Byte-exact raw header splitting — the ONE place that decides where a raw
 * RFC 5322 message's header section ends and how its fields fold.
 *
 * The DKIM signer (`@owlat/mail-message`), the DKIM/ARC verifier
 * (`@owlat/mail-auth`), the RFC 3156 extractor (`./rfc3156.ts`) and the Convex
 * Sealed-Mail code all read header fields off raw bytes. When signer and
 * verifier disagree on either rule, a message we sign fails our own
 * verification, so both rules live here:
 *
 *   - **End of the header section:** whichever of CRLFCRLF or LFLF comes first.
 *   - **Folding (RFC 5322 §2.2.3):** a continuation line starts with SP or HTAB,
 *     nothing else. A line starting with `\v` or `\f` is its own field.
 *
 * Works on binary strings (one code unit per byte, as from
 * `Buffer#toString('latin1')`), so offsets are byte offsets and a field's `raw`
 * converts back to the exact bytes. It imports nothing — no `Buffer`, no
 * `node:*` — because the Convex V8 isolate imports it through the
 * `@owlat/mail-canon/rawMessage` subpath (the package index pulls in
 * `node:buffer`).
 */

/** One header field as it appears on the wire. */
export interface RawHeaderField {
	/** Field name, trimmed and lowercased. */
	readonly name: string;
	/** Field name, trimmed, in its original case. */
	readonly casedName: string;
	/** The verbatim field (name, colon, value); folded lines rejoined with CRLF, no trailing CRLF. */
	readonly raw: string;
}

/**
 * Split a binary message string at the end of its header section: whichever
 * of CRLFCRLF or LFLF comes first. `headerBlock` excludes the separator;
 * `bodyOffset` is the first body byte (`binary.length` when there is no body).
 */
export function splitRawHeaderBlock(binary: string): { headerBlock: string; bodyOffset: number } {
	const crlf = binary.indexOf('\r\n\r\n');
	const lf = binary.indexOf('\n\n');
	if (crlf !== -1 && (lf === -1 || crlf < lf)) {
		return { headerBlock: binary.slice(0, crlf), bodyOffset: crlf + 4 };
	}
	if (lf !== -1) {
		return { headerBlock: binary.slice(0, lf), bodyOffset: lf + 2 };
	}
	return { headerBlock: binary, bodyOffset: binary.length };
}

/**
 * Parse a header block into its ordered fields. Lines may end in CRLF or bare
 * LF; a continuation line (leading SP or HTAB) is rejoined onto its field with
 * CRLF. An empty line ends the current field and is dropped.
 */
export function parseRawHeaderFields(headerBlock: string): RawHeaderField[] {
	const fields: RawHeaderField[] = [];
	let current: string | null = null;
	const flush = (): void => {
		if (current === null) return;
		const colon = current.indexOf(':');
		const casedName = (colon === -1 ? current : current.slice(0, colon)).trim();
		fields.push({ name: casedName.toLowerCase(), casedName, raw: current });
		current = null;
	};

	for (const line of headerBlock.split('\n')) {
		const content = line.endsWith('\r') ? line.slice(0, -1) : line;
		if (content === '') {
			flush();
		} else if (current !== null && (content[0] === ' ' || content[0] === '\t')) {
			current += `\r\n${content}`;
		} else {
			flush();
			current = content;
		}
	}
	flush();
	return fields;
}

/**
 * The unfolded value of the first field named `name` (case-insensitive), or
 * undefined. Each continuation line is trimmed and joined with one space; the
 * result is trimmed.
 */
export function findRawHeader(fields: readonly RawHeaderField[], name: string): string | undefined {
	const wanted = name.toLowerCase();
	for (const field of fields) {
		if (field.name !== wanted) continue;
		const colon = field.raw.indexOf(':');
		if (colon === -1) continue;
		const [first = '', ...continuations] = field.raw.slice(colon + 1).split('\r\n');
		let value = first;
		for (const line of continuations) value += ` ${line.trim()}`;
		return value.trim();
	}
	return undefined;
}
