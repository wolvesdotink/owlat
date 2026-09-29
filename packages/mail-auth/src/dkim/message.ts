/**
 * Raw RFC 822 message splitting for the DKIM and ARC verifiers: turn the
 * message bytes into its ordered header fields (verbatim, for byte-exact
 * canonicalization) and the body Buffer. A Buffer wrapper over
 * `@owlat/mail-canon`'s raw header splitter, which the outbound signer uses
 * too, so signer and verifier split every message the same way.
 */

import { parseRawHeaderFields, splitRawHeaderBlock } from '@owlat/mail-canon';

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
	const { headerBlock, bodyOffset } = splitRawHeaderBlock(raw.toString('latin1'));
	return { headerFields: parseRawHeaderFields(headerBlock), body: raw.subarray(bodyOffset) };
}
