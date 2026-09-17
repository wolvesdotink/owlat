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
 * Decode base64 into bytes, TOLERANTLY: characters outside the base64 alphabet
 * are dropped and missing padding is restored before decoding.
 *
 * That leniency is deliberate — it is what `Buffer.from(value, 'base64')` did
 * at these call sites, and the inputs are wire data (an MTA webhook body, an
 * IMAP worker's `.eml`) that legitimately arrives wrapped in CRLFs. A strict
 * `atob` would throw on those, turning a cosmetic line break into a dropped
 * message. Genuinely undecodable input yields an empty array rather than
 * throwing, matching `Buffer`'s behaviour of returning what it could read.
 */
export function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
	const cleaned = value.replace(/[^A-Za-z0-9+/]/g, '');
	const padded = cleaned.padEnd(Math.ceil(cleaned.length / 4) * 4, '=');
	let binary: string;
	try {
		binary = atob(padded);
	} catch {
		return new Uint8Array(0);
	}
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

/** Standard PADDED base64 of `text`'s UTF-8 bytes. */
export function utf8ToBase64(text: string): string {
	return bytesToBase64(new TextEncoder().encode(text));
}

/**
 * How many BYTES `text` occupies as UTF-8 — the `Buffer.byteLength(text)` any
 * size cap actually means. `text.length` counts UTF-16 code units and
 * under-counts every non-ASCII character, so it cannot stand in for this.
 */
export function utf8ByteLength(text: string): number {
	return new TextEncoder().encode(text).byteLength;
}
