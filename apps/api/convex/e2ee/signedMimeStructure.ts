/**
 * Does the `multipart/signed` first part the verifier is about to check hold
 * everything the reader will show? The second half of the PGP/MIME gate.
 *
 * `extractRfc3156SignedPart` (`@owlat/mail-canon`) slices the signed octets
 * with its own line-oriented scan, and the reader's body is built by a
 * different one: the MIME walker of `@owlat/mail-message`, which the MTA's
 * `parseMessage` (the stored text/HTML bodies) and `@owlat/shared/mailMime`
 * (the attachment list, the clearsigned body) share. Wherever the two scans
 * read a message differently (a junk-suffixed close delimiter, a bare-LF
 * delimiter, a repeated `Content-Type`), the reader could render a part the
 * signature never covered, beside a valid verdict.
 *
 * So the verdict does not rest on the extractor alone. The message is read
 * again with the reader's walker, over the same bytes (`locateMimeTree`, the
 * byte form of the walker, held to the same tree by its parity test), and the
 * signature counts only when that reading agrees:
 *   - the root is `multipart/signed` with exactly two parts and no part or
 *     depth bound was hit;
 *   - the second part, as the walker reads it, is `application/pgp-signature`;
 *   - the first part's segment is byte-for-byte the octets the extractor hands
 *     OpenPGP.
 * The reader renders leaves only, and with two parts the only leaf outside the
 * first one is the signature itself, so every displayed part is inside what
 * was signed. Outer headers (Subject among them) are not covered: RFC 3156
 * signs the body part, not the message header.
 *
 * Ambiguous structure is refused outright rather than resolved: a node with
 * more than one `Content-Type` (the walker takes the last, other readers the
 * first), and a delimiter of the `multipart/signed` boundary that is not
 * CRLF on both sides (the extractor only sees CRLF delimiters, the walker
 * also bare LF).
 *
 * Pure: bytes in, a boolean out. Any disagreement is a malformed signature.
 */

import { locateMimeTree } from '@owlat/mail-message/parse/locate';
import { getRawParam } from '@owlat/mail-message/parse/headers';
import type { MimeNode } from '@owlat/mail-message/parse/body';
import { bytesToBinaryString } from '@owlat/mail-message/parse/binaryString';

/** Whether any node of the tree carries more than one `Content-Type`. */
function hasRepeatedContentType(node: MimeNode): boolean {
	if (node.headers.getAll('content-type').length > 1) return true;
	return node.children.some(hasRepeatedContentType);
}

/**
 * Whether every line that is a delimiter of `boundary` (as the walker reads
 * one: `--boundary` or `--boundary--`, trailing spaces and tabs ignored) ends
 * in CRLF, and follows a line that did.
 */
function delimitersAreCrlf(raw: Uint8Array, boundary: string): boolean {
	const open = `--${boundary}`;
	const close = `--${boundary}--`;
	for (let pos = 0; pos < raw.length;) {
		const nl = raw.indexOf(0x0a, pos);
		const lineEnd = nl === -1 ? raw.length : nl;
		let end = lineEnd;
		while (end > pos && (raw[end - 1] === 0x20 || raw[end - 1] === 0x09 || raw[end - 1] === 0x0d)) {
			end--;
		}
		const length = end - pos;
		if (raw[pos] === 0x2d && (length === open.length || length === close.length)) {
			const line = bytesToBinaryString(raw.subarray(pos, end));
			if (line === open || line === close) {
				const endsCrlf = nl === -1 || (nl > pos && raw[nl - 1] === 0x0d);
				const followsCrlf = pos === 0 || (pos >= 2 && raw[pos - 2] === 0x0d);
				if (!endsCrlf || !followsCrlf) return false;
			}
		}
		if (nl === -1) break;
		pos = nl + 1;
	}
	return true;
}

/**
 * Whether the reader's MIME walker agrees that `signedPart` (the octets
 * `extractRfc3156SignedPart` returned for `raw`) is the first of exactly two
 * parts of a root `multipart/signed`, the second being its signature. See the
 * module comment.
 */
export function signedPartIsDisplayedBody(raw: Uint8Array, signedPart: Uint8Array): boolean {
	const { root, segments, truncated } = locateMimeTree(raw);
	if (truncated || hasRepeatedContentType(root)) return false;
	if (root.contentType.value !== 'multipart/signed' || !root.isMultipart) return false;
	const boundary = getRawParam(root.headers.last('content-type'), 'boundary');
	if (!boundary || !delimitersAreCrlf(raw, boundary)) return false;

	if (root.children.length !== 2) return false;
	const [first, signature] = root.children as [MimeNode, MimeNode];
	if (signature.isMultipart || signature.contentType.value !== 'application/pgp-signature') {
		return false;
	}
	const segment = segments.get(first);
	if (!segment || segment.end - segment.start !== signedPart.length) return false;
	for (let i = 0; i < signedPart.length; i++) {
		if (raw[segment.start + i] !== signedPart[i]) return false;
	}
	return true;
}
