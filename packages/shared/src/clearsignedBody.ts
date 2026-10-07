/**
 * Inline clearsigned mail (RFC 4880 §7) at ingest: whether a raw message is
 * clearsigned, and which block of it, tied to which octets, a signature
 * verdict may speak for.
 *
 * The verdict must describe what the reader shows, so everything here works
 * from the reader's own text body (the parser's body rule plus
 * `decodeCharset`), and the structural armor rules of `./secureMessage`.
 */

import { charsetDecoderFor, decodeCharset } from '@owlat/mail-message/parse/charset';
import { binaryStringToBytes, bytesToBinaryString, extractBodyTextParts } from './mailMime';
import {
	PGP_SIGNATURE_HEADER,
	PGP_SIGNED_HEADER,
	classifyRawSecureMessage,
	extractClearsignedBlock,
	hasClearsignedBlock,
	indexOfArmorLine,
} from './secureMessage';

/**
 * Whether a raw inbound message carries an inline clearsigned body (RFC 4880
 * §7): the `BEGIN PGP SIGNED MESSAGE` armor in its displayed `text/plain`
 * body, the same text the reader classifies.
 */
export function isClearsigned(raw: string): boolean {
	return clearsignedBody(raw) !== null;
}

/**
 * Whether a BARE body (text with no MIME headers, e.g. the AI-inbox path's
 * already-parsed text) carries an inline clearsigned block. The whole text is
 * the displayed body, so it is classified as it stands.
 */
export function isClearsignedText(text: string): boolean {
	return classifyRawSecureMessage(text) === 'pgp-clearsigned';
}

/**
 * A clearsigned message's block as the reader shows it, and what the verifier
 * may check of it.
 *   - `verifiable: true`: `text` is the block the reader displays and `octets`
 *     (a binary string, one char per byte) are the transmitted bytes that
 *     decode to exactly that text.
 *   - `verifiable: false`: the reader shows a clearsigned block, but no single
 *     set of octets can be tied to it, so no signature over it can be claimed:
 *     more than one armor block (`ambiguous`), a block that spans body parts
 *     (`split`), a part in a charset that is not ASCII-compatible (`charset`),
 *     or octets that do not decode back to the displayed text (`mismatch`).
 */
export type ClearsignedBody =
	| { verifiable: true; text: string; octets: string }
	| { verifiable: false; reason: 'ambiguous' | 'split' | 'charset' | 'mismatch' };

/**
 * Encodings whose bytes 0x00-0x7F are ASCII and never part of a multi-byte
 * character, so armor lines read the same in the octets as in the decoded text.
 * Canonical WHATWG names (`TextDecoder#encoding`). An OpenPGP cleartext
 * signature in UTF-16 or UTF-32 is not a case anyone sends.
 */
const ASCII_COMPATIBLE_ENCODINGS = new Set([
	'utf-8',
	'windows-874',
	'windows-1250',
	'windows-1251',
	'windows-1252',
	'windows-1253',
	'windows-1254',
	'windows-1255',
	'windows-1256',
	'windows-1257',
	'windows-1258',
	'iso-8859-2',
	'iso-8859-3',
	'iso-8859-4',
	'iso-8859-5',
	'iso-8859-6',
	'iso-8859-7',
	'iso-8859-8',
	'iso-8859-8-i',
	'iso-8859-10',
	'iso-8859-13',
	'iso-8859-14',
	'iso-8859-15',
	'iso-8859-16',
	'koi8-r',
	'koi8-u',
]);

function isAsciiCompatible(label: string): boolean {
	try {
		return ASCII_COMPATIBLE_ENCODINGS.has(new TextDecoder(label).encoding);
	} catch {
		// No decoder for it: the text was a byte-preserving fallback, not a charset.
		return false;
	}
}

/** How many unquoted lines open with `marker` (see {@link indexOfArmorLine}). */
function armorLineCount(body: string, marker: string): number {
	let count = 0;
	for (let at = indexOfArmorLine(body, marker); at >= 0;) {
		count++;
		at = indexOfArmorLine(body, marker, at + marker.length);
	}
	return count;
}

/** One block, opened and signed once, or the input is ambiguous. */
function hasOneArmorBlock(text: string): boolean {
	return (
		armorLineCount(text, PGP_SIGNED_HEADER) === 1 &&
		armorLineCount(text, PGP_SIGNATURE_HEADER) === 1
	);
}

/**
 * The inline clearsigned block of a raw message (a binary string), bound to
 * what the reader displays, or null when the reader would not show one.
 *
 * The reader's text body is every non-attachment `text/plain` leaf
 * (`extractBodyTextParts`, the parser's own rule) decoded with `decodeCharset`
 * and joined with `\n`; this rebuilds exactly that text and classifies it the
 * way the reader does. The block found in it is then traced back to the one
 * leaf it sits in and that leaf's transmitted octets, which must decode, under
 * the decoder the reader used, to the identical block text. Anything that
 * breaks that chain is `verifiable: false`. A raw message that classifies as
 * PGP/MIME or S/MIME is never clearsigned.
 */
export function clearsignedBody(raw: string): ClearsignedBody | null {
	const rawClass = classifyRawSecureMessage(raw);
	if (rawClass !== 'none' && rawClass !== 'pgp-clearsigned') return null;
	const leaves = extractBodyTextParts(raw).map((part) => ({
		part,
		text: decodeCharset(part.bytes, part.charset),
	}));
	const displayed = leaves.map((leaf) => leaf.text).join('\n');
	if (!hasClearsignedBlock(displayed)) return null;
	if (!hasOneArmorBlock(displayed)) return { verifiable: false, reason: 'ambiguous' };
	const shown = extractClearsignedBlock(displayed)!;

	// The single header line opens in exactly one leaf; the whole block must be there.
	const leaf = leaves.find((l) => indexOfArmorLine(l.text, PGP_SIGNED_HEADER) >= 0);
	if (!leaf || extractClearsignedBlock(leaf.text) !== shown) {
		return { verifiable: false, reason: 'split' };
	}
	const decoder = charsetDecoderFor(leaf.part.bytes, leaf.part.charset);
	if (!isAsciiCompatible(decoder.label)) return { verifiable: false, reason: 'charset' };
	const octets = extractClearsignedBlock(
		bytesToBinaryString(leaf.part.bytes.subarray(decoder.skip))
	);
	if (octets === null || decodeCharset(binaryStringToBytes(octets), decoder.label) !== shown) {
		return { verifiable: false, reason: 'mismatch' };
	}
	return { verifiable: true, text: shown, octets };
}

/**
 * {@link clearsignedBody} for a BARE body: already-decoded text with no MIME
 * headers (the AI-inbox path), which is all of the displayed body. Its octets
 * are its UTF-8 encoding, as the sender's text arrived there.
 */
export function clearsignedBareBody(text: string): ClearsignedBody | null {
	if (!isClearsignedText(text)) return null;
	if (!hasOneArmorBlock(text)) return { verifiable: false, reason: 'ambiguous' };
	const shown = extractClearsignedBlock(text)!;
	return {
		verifiable: true,
		text: shown,
		octets: bytesToBinaryString(new TextEncoder().encode(shown)),
	};
}
