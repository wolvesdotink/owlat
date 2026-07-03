/**
 * BODY section/partial parsing + slicing for FETCH.
 *
 * Pure functions over the requested item token and the message's raw
 * RFC822 bytes. Co-located with the FETCH module because it is the only
 * consumer. Covers the RFC 3501 §6.4.5 forms the server supports:
 *
 *   - `BODY[]`            — the whole message
 *   - `BODY[HEADER]`      — the header block (up to and including the
 *                           blank line that terminates the headers)
 *   - `BODY[TEXT]`        — the body that follows the header block
 *   - `BODY[<n>]`         — a non-multipart message has a single part `1`,
 *                           which is treated as `TEXT`
 *   - `RFC822`            — alias for `BODY[]` (and sets \Seen like a
 *                           non-PEEK BODY[])
 *   - `RFC822.HEADER`     — alias for `BODY.PEEK[HEADER]`
 *   - `RFC822.TEXT`       — alias for `BODY[TEXT]`
 *
 * Each form may be requested with the `.PEEK` modifier (`BODY.PEEK[...]`)
 * which suppresses the implicit \Seen, and with a partial
 * `<offset.length>` suffix which returns at most `length` octets starting
 * at `offset`. The response key echoes the requested section (without the
 * `.PEEK`, per §7.4.2) and, for a partial, the origin octet.
 */

export interface BodySectionRequest {
	/** The section spec as it should appear in the response key, e.g. ''
	 *  for BODY[], 'HEADER', 'TEXT', '1'. Always upper-cased. */
	readonly section: string;
	/** True for BODY.PEEK[...] / RFC822.HEADER — do not set \Seen. */
	readonly peek: boolean;
	/** Partial <offset.length>, if requested. */
	readonly partial?: { readonly offset: number; readonly length: number };
	/** The original RFC822* alias, so the response can echo it verbatim
	 *  instead of the BODY[...] form. undefined for BODY[...] requests. */
	readonly rfc822Alias?: 'RFC822' | 'RFC822.HEADER' | 'RFC822.TEXT';
}

const BODY_RE = /^BODY(\.PEEK)?\[([^\]]*)\](?:<(\d+)\.(\d+)>)?$/;

/**
 * Parse a single FETCH item into a BODY section request, or null if the
 * item is not a body-bearing item this module handles. The caller has
 * already upper-cased the token.
 */
export function parseBodySectionItem(item: string): BodySectionRequest | null {
	if (item === 'RFC822') return { section: '', peek: false, rfc822Alias: 'RFC822' };
	if (item === 'RFC822.HEADER') {
		return { section: 'HEADER', peek: true, rfc822Alias: 'RFC822.HEADER' };
	}
	if (item === 'RFC822.TEXT') {
		return { section: 'TEXT', peek: false, rfc822Alias: 'RFC822.TEXT' };
	}

	const m = BODY_RE.exec(item);
	if (!m) return null;
	const peek = m[1] === '.PEEK';
	const section = m[2] ?? '';
	const partial =
		m[3] !== undefined && m[4] !== undefined
			? { offset: parseInt(m[3], 10), length: parseInt(m[4], 10) }
			: undefined;
	return { section, peek, partial };
}

/**
 * Split raw RFC822 bytes into the header block and the text body. The
 * header block includes the terminating blank line (CRLF CRLF or LF LF).
 * If no blank line is found the whole message is treated as the header
 * and the text is empty (matching how servers report a header-only blob).
 *
 * Operates on raw octets (a `Buffer`): the message body is arbitrary
 * 8-bit/binary MIME, so slicing must happen at byte offsets, never on a
 * lossily-decoded UTF-16 string. `subarray` returns a view (no copy) into
 * the same backing store.
 */
export function splitHeaderText(raw: Buffer): { header: Buffer; text: Buffer } {
	const crlf = raw.indexOf('\r\n\r\n');
	if (crlf !== -1) {
		return { header: raw.subarray(0, crlf + 4), text: raw.subarray(crlf + 4) };
	}
	const lf = raw.indexOf('\n\n');
	if (lf !== -1) {
		return { header: raw.subarray(0, lf + 2), text: raw.subarray(lf + 2) };
	}
	return { header: raw, text: Buffer.alloc(0) };
}

/** Resolve the section octets (before any partial slicing) for a request. */
export function sectionBytes(req: BodySectionRequest, raw: Buffer): Buffer {
	switch (req.section) {
		case '':
			return raw;
		case 'HEADER':
			return splitHeaderText(raw).header;
		case 'TEXT':
			return splitHeaderText(raw).text;
		default:
			// A non-multipart message has exactly one part, numbered `1`,
			// whose content is the TEXT body. Any other part number has no
			// content.
			return req.section === '1' ? splitHeaderText(raw).text : Buffer.alloc(0);
	}
}

/**
 * Build the response key + body literal for a BODY section request as raw
 * octets, ready to splice into the FETCH response, e.g. the octets for
 * `BODY[HEADER] {17}\r\n...` or `BODY[]<0> {5}\r\nHello`.
 *
 * The declared `{N}` is the EXACT byte length of the sliced section (RFC
 * 3501 §4.3) — for any 8-bit/UTF-8/emoji body a UTF-16 code-unit count
 * would under-declare the octets and desync the client's literal framing,
 * corrupting every following response. The literal header is pure ASCII;
 * the body octets are appended verbatim.
 */
export function formatBodySection(req: BodySectionRequest, raw: Buffer): Buffer {
	let bytes = sectionBytes(req, raw);
	let originOctet: number | undefined;
	if (req.partial) {
		originOctet = req.partial.offset;
		bytes = bytes.subarray(req.partial.offset, req.partial.offset + req.partial.length);
	}

	const responsePrefix =
		req.rfc822Alias ??
		`BODY[${req.section}]${originOctet !== undefined ? `<${originOctet}>` : ''}`;
	return Buffer.concat([
		Buffer.from(`${responsePrefix} {${bytes.length}}\r\n`, 'ascii'),
		bytes,
	]);
}
