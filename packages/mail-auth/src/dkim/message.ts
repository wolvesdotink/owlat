/**
 * Raw RFC 822 message splitting for the DKIM verifier: turn the message bytes
 * into its ordered header fields (verbatim, for byte-exact canonicalization)
 * and the body Buffer. Kept separate from `verify.ts` so the verifier core
 * stays focused on the DKIM state machine.
 */

/** A parsed raw header field: lowercased name plus verbatim bytes (no CRLF). */
export interface HeaderField {
	readonly name: string;
	readonly raw: string;
}

/**
 * Split a raw message into its ordered header fields and its body. The header
 * block is decoded latin1 so canonicalization stays byte-exact; the body stays
 * a Buffer. Folded continuation lines are rejoined with CRLF into one field.
 */
export function splitMessage(raw: Buffer): { headerFields: HeaderField[]; body: Buffer } {
	const crlfIdx = raw.indexOf('\r\n\r\n');
	const lfIdx = raw.indexOf('\n\n');
	let boundary = -1;
	let sepLen = 0;
	if (crlfIdx !== -1 && (lfIdx === -1 || crlfIdx <= lfIdx)) {
		boundary = crlfIdx;
		sepLen = 4;
	} else if (lfIdx !== -1) {
		boundary = lfIdx;
		sepLen = 2;
	}

	const headerBlock = (boundary === -1 ? raw : raw.subarray(0, boundary)).toString('latin1');
	const body = boundary === -1 ? Buffer.alloc(0) : raw.subarray(boundary + sepLen);
	return { headerFields: parseHeaderFields(headerBlock), body };
}

/** Parse a header block into ordered fields, rejoining folded lines. */
function parseHeaderFields(headerBlock: string): HeaderField[] {
	const fields: HeaderField[] = [];
	let current: string | null = null;
	const flush = (): void => {
		if (current === null) {
			return;
		}
		const colon = current.indexOf(':');
		const name = (colon === -1 ? current : current.slice(0, colon)).trim().toLowerCase();
		fields.push({ name, raw: current });
		current = null;
	};

	for (const line of headerBlock.split('\n')) {
		const content = line.endsWith('\r') ? line.slice(0, -1) : line;
		if ((content.startsWith(' ') || content.startsWith('\t')) && current !== null) {
			current += `\r\n${content}`;
		} else {
			flush();
			current = content;
		}
	}
	flush();
	return fields;
}
