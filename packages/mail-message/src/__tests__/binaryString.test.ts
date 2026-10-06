/**
 * `parse/binaryString`: the byte <-> binary-string conversion every caller uses
 * before handing a raw `.eml` to the walker (#1279). `TextDecoder('latin1')`,
 * which those callers used before, is windows-1252 and changes bytes 0x80-0x9F;
 * the cases below fail with it in place of `bytesToBinaryString`.
 */
import { describe, expect, it } from 'vitest';
import { binaryStringToBytes, bytesToBinaryString } from '../parse/binaryString';
import { extractAttachments } from '../parse/attachments';
import { parseMessage } from '../parse/index';

/** The binary attachment of #1279, every byte a windows-1252 decode changes or keeps. */
const BINARY_PART = [0x00, 0x41, 0x80, 0x99, 0x9f, 0xa0, 0xff];
const BODY_TEXT = 'Price — “quoted” 5€';

/** An 8-bit UTF-8 text part and a `binary` attachment, as raw bytes. */
function eightBitMessage(): Uint8Array {
	const encoder = new TextEncoder();
	const head = encoder.encode(
		[
			'From: sender@example.com',
			'To: owner@example.com',
			'Subject: Price list',
			'MIME-Version: 1.0',
			'Content-Type: multipart/mixed; boundary="b"',
			'',
			'--b',
			'Content-Type: text/plain; charset=utf-8',
			'Content-Transfer-Encoding: 8bit',
			'',
			BODY_TEXT,
			'--b',
			'Content-Type: application/octet-stream; name="blob.bin"',
			'Content-Disposition: attachment; filename="blob.bin"',
			'Content-Transfer-Encoding: binary',
			'',
			'',
		].join('\r\n')
	);
	const tail = encoder.encode('\r\n--b--\r\n');
	const out = new Uint8Array(head.length + BINARY_PART.length + tail.length);
	out.set(head);
	out.set(BINARY_PART, head.length);
	out.set(tail, head.length + BINARY_PART.length);
	return out;
}

describe('bytesToBinaryString', () => {
	it('maps every byte value to the char of the same code', () => {
		const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
		const binary = bytesToBinaryString(bytes);
		expect([...binary].map((c) => c.charCodeAt(0))).toEqual([...bytes]);
		// The trap this replaces: the WHATWG `latin1` label is windows-1252.
		expect(new TextDecoder('latin1').decode(bytes)).not.toBe(binary);
	});

	it('matches Buffer latin1 across the chunk boundary', () => {
		const bytes = Uint8Array.from({ length: 0x8000 * 2 + 7 }, (_, i) => (i * 31) % 256);
		const binary = bytesToBinaryString(bytes);
		expect(binary).toHaveLength(bytes.length);
		expect(binary).toBe(Buffer.from(bytes).toString('latin1'));
	});
});

describe('binaryStringToBytes', () => {
	it('is the exact inverse', () => {
		const bytes = Uint8Array.from({ length: 0x8000 + 300 }, (_, i) => i % 256);
		expect([...binaryStringToBytes(bytesToBinaryString(bytes))]).toEqual([...bytes]);
	});

	it('refuses a char that has no byte instead of keeping its low byte', () => {
		expect(() => binaryStringToBytes('a€b')).toThrow(RangeError);
		expect(() => binaryStringToBytes('a€b')).toThrow('U+20AC at index 1');
	});
});

describe('the walker over a byte-exact binary string', () => {
	it('round-trips a binary attachment byte for byte', () => {
		const [attachment] = extractAttachments(bytesToBinaryString(eightBitMessage()));
		expect(attachment?.filename).toBe('blob.bin');
		expect([...(attachment?.content ?? [])]).toEqual(BINARY_PART);
	});

	it('decodes an 8-bit UTF-8 body, and parses the same as from a Buffer', () => {
		const raw = eightBitMessage();
		const fromString = parseMessage(bytesToBinaryString(raw));
		expect(fromString.text).toBe(BODY_TEXT);
		expect(fromString.text).toBe(parseMessage(Buffer.from(raw)).text);
	});
});
