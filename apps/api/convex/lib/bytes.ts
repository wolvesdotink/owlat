/**
 * Byte ↔ string conversions for the Convex V8 runtime.
 *
 * Convex runs `'use node'` modules under Node and everything else in a V8
 * isolate that has NO `Buffer`. `Buffer.from(x, 'base64')` in an isolate module
 * is not a build error — it throws a `ReferenceError` on the first call, which
 * is how every IMAP-synced message silently failed to land for three releases.
 * These helpers are the Web-standard replacements, so an isolate module never
 * needs the Node global; `scripts/check-convex-node-globals.ts` keeps it that
 * way.
 *
 * Node modules may use them too — `atob`/`btoa`/`TextEncoder` are standard in
 * both runtimes, so nothing here has to know which one it is in.
 */

/**
 * `String.fromCharCode` takes its arguments on the stack, so a whole multi-MB
 * message would overflow it. Convert in chunks well under any engine's limit.
 */
const BINARY_STRING_CHUNK = 0x8000;

/** One encoder for the module — constructing one per call is not free. */
const ENCODER = new TextEncoder();

/**
 * The bytes as a binary ("latin1") string — one character per byte.
 *
 * This is the shape `atob`/`btoa` speak, and the shape the MIME walker in
 * `@owlat/shared/mailMime` wants so that binary attachment parts survive being
 * handed around as a string.
 */
export function bytesToBinaryString(bytes: Uint8Array): string {
	let binary = '';
	for (let offset = 0; offset < bytes.length; offset += BINARY_STRING_CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + BINARY_STRING_CHUNK));
	}
	return binary;
}

/** Standard PADDED base64 of `bytes` — the `Buffer#toString('base64')` shape. */
export function bytesToBase64(bytes: Uint8Array): string {
	return btoa(bytesToBinaryString(bytes));
}

/**
 * Decode base64 into bytes the way `Buffer.from(value, 'base64')` did.
 *
 * Node's decoder is tolerant in four specific ways that `atob` is not, and the
 * call sites depend on all of them — the inputs are wire data (an MTA webhook
 * body, an IMAP worker's `.eml`) that legitimately arrives CRLF-wrapped, and a
 * strict decode would turn a cosmetic line break into a dropped message:
 *
 *   · it accepts the URL-SAFE alphabet (`-`/`_`) as well as the standard one.
 *     Dropping those characters instead of translating them is worse than
 *     throwing: it shifts every byte that follows and yields a plausible wrong
 *     answer;
 *   · it ignores characters outside both alphabets (whitespace, CRLF);
 *   · it stops at the first `=`, so trailing junk cannot extend the output;
 *   · it discards a trailing orphan character (`length % 4 === 1`), which
 *     encodes no whole byte, rather than failing the whole string.
 *
 * Genuinely undecodable input yields an empty array rather than throwing, which
 * is also what `Buffer` did. Callers for which empty is not a legal answer must
 * say so themselves — see the ingest paths, which treat it as a failed message.
 */
export function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
	let cleaned = value
		.replace(/-/g, '+')
		.replace(/_/g, '/')
		.replace(/[^A-Za-z0-9+/=]/g, '');
	const terminator = cleaned.indexOf('=');
	if (terminator !== -1) cleaned = cleaned.slice(0, terminator);
	const remainder = cleaned.length % 4;
	if (remainder === 1) {
		cleaned = cleaned.slice(0, -1); // an orphan sextet encodes no whole byte
	} else if (remainder > 0) {
		cleaned = cleaned.padEnd(cleaned.length + (4 - remainder), '=');
	}
	let binary: string;
	try {
		binary = atob(cleaned);
	} catch {
		return new Uint8Array(0);
	}
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

/** Standard PADDED base64 of `text`'s UTF-8 bytes. */
export function utf8ToBase64(text: string): string {
	return bytesToBase64(utf8Bytes(text));
}

/** `text` as UTF-8 bytes. */
export function utf8Bytes(text: string): Uint8Array<ArrayBuffer> {
	return ENCODER.encode(text);
}

/**
 * How many BYTES one CHARACTER occupies as UTF-8 — arithmetic, from the code
 * point's range. Unlike `Buffer.byteLength`, encoding a string to measure it
 * allocates the encoded copy, so a per-character caller (`plugins/workerTasks`
 * clamps untrusted text one character at a time) must not go through the
 * encoder at all. A lone surrogate encodes as U+FFFD, three bytes.
 */
export function utf8CharWidth(character: string): number {
	const codePoint = character.codePointAt(0) ?? 0;
	if (codePoint < 0x80) return 1;
	if (codePoint < 0x800) return 2;
	if (codePoint < 0x10000) return 3;
	return 4;
}
