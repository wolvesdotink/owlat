import { describe, it, expect } from 'vitest';
import {
	binaryStringToBytes,
	bytesToBinaryString,
	extractAttachments,
	extractBodyTextParts,
	extractAttachmentAt,
	extractFirstPartByType,
} from '../mailMime';

const decode = (b: Uint8Array) => new TextDecoder('utf-8').decode(b);

describe('extractFirstPartByType', () => {
	it('reaches an inline text/calendar part with no disposition or filename', () => {
		const raw = [
			'Content-Type: multipart/alternative; boundary="b"',
			'',
			'--b',
			'Content-Type: text/plain',
			'',
			'You are invited',
			'--b',
			'Content-Type: text/calendar; method=REQUEST; charset=UTF-8',
			'',
			'BEGIN:VCALENDAR',
			'END:VCALENDAR',
			'--b--',
		].join('\r\n');
		const part = extractFirstPartByType(raw, 'text/calendar');
		expect(part).not.toBeNull();
		expect(decode(part!.bytes)).toContain('BEGIN:VCALENDAR');
		// The attachment walk skips it (no disposition/filename) — hence this API.
		expect(extractAttachments(raw)).toHaveLength(0);
	});

	it('returns null when no part matches', () => {
		const raw = ['Content-Type: text/plain', '', 'hello'].join('\r\n');
		expect(extractFirstPartByType(raw, 'text/calendar')).toBeNull();
	});

	it('treats a part with an empty Content-Type as text/plain', () => {
		const raw = [
			'Content-Type: multipart/mixed; boundary="E"',
			'',
			'--E',
			'Content-Type:',
			'',
			'untyped',
			'--E--',
		].join('\r\n');
		const part = extractFirstPartByType(raw, 'text/plain');
		expect(part?.contentType).toBe('text/plain');
		expect(part?.charset).toBeUndefined();
		expect(new TextDecoder().decode(part!.bytes)).toBe('untyped');
	});
});

// multipart/mixed wrapping a multipart/alternative (text+html, NOT attachments)
// plus a base64 attachment and a quoted-printable attachment.
const RAW = [
	'Content-Type: multipart/mixed; boundary="OUTER"',
	'',
	'--OUTER',
	'Content-Type: multipart/alternative; boundary="INNER"',
	'',
	'--INNER',
	'Content-Type: text/plain',
	'',
	'hello',
	'--INNER',
	'Content-Type: text/html',
	'',
	'<p>hello</p>',
	'--INNER--',
	'--OUTER',
	'Content-Type: text/plain; charset=utf-8',
	'Content-Disposition: attachment; filename="notes.txt"',
	'Content-Transfer-Encoding: base64',
	'',
	'aGVsbG8gd29ybGQ=',
	'--OUTER',
	'Content-Type: application/octet-stream; name="data.bin"',
	'Content-Transfer-Encoding: quoted-printable',
	'Content-Disposition: attachment; filename="data.bin"',
	'',
	'A=3DB',
	'--OUTER--',
	'',
].join('\n');

describe('extractBodyTextParts', () => {
	it('returns the text/plain leaves the displayed body is made of, never an attachment', () => {
		const raw = [
			'Content-Type: multipart/mixed; boundary="b"',
			'',
			'--b',
			'Content-Type: text/plain; name="notes.txt"',
			'Content-Disposition: attachment',
			'',
			'attached text',
			'--b',
			'Content-Type: text/plain; charset=iso-8859-1',
			'Content-Transfer-Encoding: quoted-printable',
			'',
			'Gr=FC=DFe',
			'--b',
			'Content-Type: text/html',
			'',
			'<p>html</p>',
			'--b',
			'Content-Type: text/plain',
			'',
			'footer',
			'--b--',
		].join('\r\n');
		const parts = extractBodyTextParts(raw);
		expect(parts.map((part) => bytesToBinaryString(part.bytes).trim())).toEqual([
			'Gr\xfc\xdfe',
			'footer',
		]);
		expect(parts[0]!.charset).toBe('iso-8859-1');
	});
});

describe('extractAttachments', () => {
	it('returns only attachment leaves, in document order, decoded', () => {
		const atts = extractAttachments(RAW);
		expect(atts.map((a) => a.filename)).toEqual(['notes.txt', 'data.bin']);
		expect(decode(atts[0]!.bytes)).toBe('hello world');
		expect(decode(atts[1]!.bytes)).toBe('A=B');
		expect(atts[1]!.contentType).toBe('application/octet-stream');
	});

	it('returns nothing for a plain message with no attachments', () => {
		const raw = ['Content-Type: text/plain', '', 'just text'].join('\n');
		expect(extractAttachments(raw)).toEqual([]);
	});

	it('one corrupt base64 part does not drop the other attachments', () => {
		const raw = [
			'Content-Type: multipart/mixed; boundary="B"',
			'',
			'--B',
			'Content-Type: application/octet-stream; name="bad.bin"',
			'Content-Transfer-Encoding: base64',
			'Content-Disposition: attachment; filename="bad.bin"',
			'',
			'!!!not base64!!!',
			'--B',
			'Content-Type: text/plain; charset=utf-8',
			'Content-Disposition: attachment; filename="good.txt"',
			'Content-Transfer-Encoding: base64',
			'',
			'aGVsbG8=',
			'--B--',
			'',
		].join('\n');
		const atts = extractAttachments(raw);
		expect(atts.map((a) => a.filename)).toEqual(['bad.bin', 'good.txt']);
		expect(decode(atts[1]!.bytes)).toBe('hello');
	});
});

describe('extractAttachmentAt', () => {
	it('selects by partIndex', () => {
		expect(extractAttachmentAt(RAW, '0')?.filename).toBe('notes.txt');
		expect(extractAttachmentAt(RAW, '1')?.filename).toBe('data.bin');
	});

	it('falls back to filename when the index drifts', () => {
		expect(extractAttachmentAt(RAW, '9', 'data.bin')?.filename).toBe('data.bin');
	});

	it('reads a raw UTF-8 filename as ingest stored it (RFC 6532)', () => {
		const raw = bytesToBinaryString(
			new TextEncoder().encode(
				[
					'Content-Type: multipart/mixed; boundary="b"',
					'',
					'--b',
					'Content-Type: application/pdf',
					'Content-Disposition: attachment; filename="Rechnung März.pdf"',
					'',
					'x',
					'--b--',
				].join('\r\n')
			)
		);
		expect(extractAttachments(raw).map((a) => a.filename)).toEqual(['Rechnung März.pdf']);
		expect(extractAttachmentAt(raw, '9', 'Rechnung März.pdf')?.filename).toBe('Rechnung März.pdf');
	});

	it('returns null when nothing matches', () => {
		expect(extractAttachmentAt(RAW, '9', 'missing.pdf')).toBeNull();
	});
});

describe('a raw message read from its bytes (#1279)', () => {
	const BINARY_PART = [0x00, 0x41, 0x80, 0x99, 0x9f, 0xa0, 0xff];
	const raw = (() => {
		const encoder = new TextEncoder();
		const head = encoder.encode(
			[
				'Content-Type: multipart/mixed; boundary="b"',
				'',
				'--b',
				'Content-Type: text/plain; charset=utf-8',
				'Content-Transfer-Encoding: 8bit',
				'',
				'Price — “quoted” 5€',
				'--b',
				'Content-Type: application/octet-stream; name="blob.bin"',
				'Content-Disposition: attachment; filename="blob.bin"',
				'Content-Transfer-Encoding: binary',
				'',
				'',
			].join('\r\n')
		);
		return Uint8Array.from([...head, ...BINARY_PART, ...encoder.encode('\r\n--b--\r\n')]);
	})();

	it('extracts a binary attachment byte for byte', () => {
		const text = bytesToBinaryString(raw);
		expect([...extractAttachments(text)[0]!.bytes]).toEqual(BINARY_PART);
		expect([...extractAttachmentAt(text, '0', 'blob.bin')!.bytes]).toEqual(BINARY_PART);
	});

	it('leaves an 8-bit UTF-8 text part decodable', () => {
		const part = extractFirstPartByType(bytesToBinaryString(raw), 'text/plain');
		expect(part!.charset).toBe('utf-8');
		expect(decode(part!.bytes)).toBe('Price — “quoted” 5€');
	});

	it('is not what a windows-1252 decode gives', () => {
		// `TextDecoder('latin1')` is windows-1252: the bug these callers had.
		const wrong = extractAttachments(new TextDecoder('latin1').decode(raw))[0]!;
		expect([...wrong.bytes]).not.toEqual(BINARY_PART);
		expect([...binaryStringToBytes(bytesToBinaryString(raw))]).toEqual([...raw]);
	});
});

// decodeEncodedWords — charset honoring (the old copy always decoded UTF-8)
import { decodeEncodedWords } from '../mailMime';

describe('decodeEncodedWords', () => {
	it('decodes UTF-8 B-encoding', () => {
		const b64 = Buffer.from('Grüße', 'utf-8').toString('base64');
		expect(decodeEncodedWords(`=?utf-8?B?${b64}?=`)).toBe('Grüße');
	});

	it('honors a non-UTF-8 declared charset (ISO-8859-1 Q-encoding)', () => {
		// 0xE9 is é in latin-1; decoding it as utf-8 would mangle it.
		expect(decodeEncodedWords('=?iso-8859-1?Q?caf=E9?=')).toBe('café');
	});

	it('falls back to utf-8 for an unknown charset', () => {
		const b64 = Buffer.from('plain', 'utf-8').toString('base64');
		expect(decodeEncodedWords(`=?x-no-such-charset?B?${b64}?=`)).toBe('plain');
	});

	it('leaves the original word intact on undecodable payloads', () => {
		expect(decodeEncodedWords('=?utf-8?B?!!!notbase64!!!?=')).toBe('=?utf-8?B?!!!notbase64!!!?=');
	});
});
