/**
 * Raw message bytes <-> the "binary string" the MIME walker of `./body.ts`
 * reads: one UTF-16 code unit per byte, its value equal to the byte
 * (0x00-0xFF). This is the one conversion every caller that holds a raw `.eml`
 * as bytes uses before handing it to the walker, and the one way back.
 *
 * NOT `new TextDecoder('latin1')`. Under the WHATWG Encoding spec, which Node,
 * Bun and browsers follow, the `latin1`, `iso-8859-1`, `ascii` and `us-ascii`
 * labels all mean windows-1252: bytes 0x80-0x9F decode to characters such as
 * U+20AC and U+2122, whose low byte is not the byte that was read, so a binary
 * or 8-bit part came out changed (#1279). `String.fromCharCode` is exact in
 * every runtime, the Convex isolate included. (`Buffer#toString('latin1')` is
 * exact too, where Node has it.)
 */

/**
 * `String.fromCharCode` takes its arguments on the stack, so a whole multi-MB
 * message would overflow it. Convert in chunks well under any engine's limit.
 */
const CHUNK = 0x8000;

/** The bytes as a binary string: char code `i` is byte `i`, exactly. */
export function bytesToBinaryString(bytes: Uint8Array): string {
	let binary = '';
	for (let offset = 0; offset < bytes.length; offset += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
	}
	return binary;
}

/**
 * The inverse of {@link bytesToBinaryString}. A char above U+00FF has no byte,
 * so the string was not a binary string: that throws a `RangeError` rather than
 * keeping the char's low byte, which is how #1279 lost data without a trace.
 */
export function binaryStringToBytes(binary: string): Uint8Array<ArrayBuffer> {
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		const code = binary.charCodeAt(i);
		if (code > 0xff) {
			const hex = code.toString(16).toUpperCase().padStart(4, '0');
			throw new RangeError(`Not a binary string: U+${hex} at index ${i}`);
		}
		bytes[i] = code;
	}
	return bytes;
}
