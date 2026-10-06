/**
 * Header text decoded from the bytes of the message (#1297, #1298).
 *
 * Every ingest path hands `parseMessage` the raw bytes, which it reads one char
 * per byte. A header may carry UTF-8 unencoded (RFC 6532), so the subject,
 * display names and filenames must be decoded from those bytes, with
 * windows-1252 as the fallback for legacy 8-bit headers, before RFC 2047
 * encoded words are. Text decoded from an encoded word can carry CR, LF and
 * other controls; the subject and names come out as one line.
 */

import { describe, it, expect } from 'vitest';
import { parseMessage } from '../parse/index';
import { bytesToBinaryString } from '../parse/binaryString';
import { headerBytesToText, splitHeaderLines } from '../parse/headers';

const eml = (...lines: string[]): string => lines.join('\r\n');

/** A message whose headers are `headers`, sent as UTF-8 bytes. */
function utf8Message(...headers: string[]): Buffer {
	return Buffer.from(
		eml(
			...headers,
			'To: b@example.com',
			'Content-Type: text/plain; charset=utf-8',
			'Content-Transfer-Encoding: 8bit',
			'',
			'Hallo'
		),
		'utf-8'
	);
}

/** One attachment with the given header lines, as UTF-8 bytes. */
function attachmentMessage(...partHeaders: string[]): Buffer {
	return Buffer.from(
		eml(
			'From: a@example.com',
			'Subject: files',
			'MIME-Version: 1.0',
			'Content-Type: multipart/mixed; boundary="B"',
			'',
			'--B',
			'Content-Type: text/plain',
			'',
			'see attached',
			'--B',
			...partHeaders,
			'Content-Transfer-Encoding: base64',
			'',
			'JVBERi0=',
			'--B--',
			''
		),
		'utf-8'
	);
}

function firstFrom(raw: Buffer | string): { name: string; address: string } | undefined {
	const from = parseMessage(raw).from;
	return (Array.isArray(from) ? from[0] : from)?.value[0];
}

describe('raw UTF-8 headers (RFC 6532)', () => {
	it('decodes a raw UTF-8 subject', () => {
		const parsed = parseMessage(utf8Message('From: a@example.com', 'Subject: Grüße aus Köln'));
		expect(parsed.subject).toBe('Grüße aus Köln');
	});

	it('decodes raw UTF-8 display names and group names', () => {
		const parsed = parseMessage(
			utf8Message(
				'From: Jörg Müller <joerg@example.com>',
				'Cc: "Bjørn, Øst" <bjorn@example.com>, Équipe: zoë@example.com;',
				'Subject: x'
			)
		);
		expect(firstFrom(utf8Message('From: Jörg Müller <joerg@example.com>'))).toEqual({
			name: 'Jörg Müller',
			address: 'joerg@example.com',
		});
		const cc = Array.isArray(parsed.cc) ? parsed.cc[0] : parsed.cc;
		expect(cc?.value[0]).toEqual({ name: 'Bjørn, Øst', address: 'bjorn@example.com' });
		expect(cc?.value[1]?.name).toBe('Équipe');
		expect(cc?.value[1]?.group).toEqual([{ name: '', address: 'zoë@example.com' }]);
		expect(cc?.text).toBe('"Bjørn, Øst" <bjorn@example.com>, Équipe: zoë@example.com;');
	});

	it.each([
		[
			'Content-Disposition filename',
			[
				'Content-Type: application/pdf',
				'Content-Disposition: attachment; filename="Rechnung März.pdf"',
			],
		],
		['Content-Type name', ['Content-Type: application/pdf; name="Rechnung März.pdf"']],
	])('decodes a raw UTF-8 filename from the %s', (_where, headers) => {
		const [attachment] = parseMessage(attachmentMessage(...headers)).attachments;
		expect(attachment?.filename).toBe('Rechnung März.pdf');
	});

	it('decodes an RFC 2231 filename whose bytes are partly raw UTF-8', () => {
		const [attachment] = parseMessage(
			attachmentMessage(
				'Content-Type: application/pdf',
				"Content-Disposition: attachment; filename*=utf-8''M%C3%A4rz_für.pdf"
			)
		).attachments;
		expect(attachment?.filename).toBe('März_für.pdf');
	});

	it.each([
		['à', 'Voilà'],
		['Р', 'Привет, Р'],
		['😠', 'Grr 😠'],
	])('keeps a subject, name and filename whose last character is %s', (_last, text) => {
		// Each ends in the byte 0xA0, which `String#trim` takes for a no-break
		// space when it runs on the bytes instead of the text.
		const parsed = parseMessage(utf8Message(`From: "${text}" <a@example.com>`, `Subject: ${text}`));
		expect(parsed.subject).toBe(text);
		expect(firstFrom(utf8Message(`From: "${text}" <a@example.com>`))?.name).toBe(text);
		const [attachment] = parseMessage(
			attachmentMessage(
				'Content-Type: application/pdf',
				`Content-Disposition: attachment; filename=${text}`
			)
		).attachments;
		expect(attachment?.filename).toBe(text);
	});

	it('unfolds a folded raw UTF-8 subject', () => {
		const parsed = parseMessage(
			utf8Message('From: a@example.com', 'Subject: Grüße aus\r\n dem Café, voilà')
		);
		expect(parsed.subject).toBe('Grüße aus dem Café, voilà');
	});

	it('decodes raw UTF-8 text and an encoded word in one subject', () => {
		const parsed = parseMessage(
			utf8Message('From: a@example.com', 'Subject: Grüße =?ISO-8859-1?Q?aus_K=F6ln?=')
		);
		expect(parsed.subject).toBe('Grüße aus Köln');
	});

	it('parses a Buffer and its binary string the same', () => {
		const raw = utf8Message('From: Jörg <j@example.com>', 'Subject: Grüße 😠');
		const fromBuffer = parseMessage(raw);
		const fromString = parseMessage(bytesToBinaryString(raw));
		expect(fromString.subject).toBe(fromBuffer.subject);
		expect(fromString.from).toEqual(fromBuffer.from);
		expect(fromBuffer.subject).toBe('Grüße 😠');
	});

	it('refuses decoded text, which it would decode a second time', () => {
		expect(() => parseMessage('Subject: Привет\r\n\r\nbody')).toThrow(RangeError);
		expect(() => parseMessage('Subject: Привет\r\n\r\nbody')).toThrow('U+041F at index 9');
	});
});

describe('legacy 8-bit headers', () => {
	it('reads bytes that are not UTF-8 as windows-1252', () => {
		const raw = Buffer.from(
			eml(
				'From: Jörg Müller <j@example.com>',
				'Subject: Grüße aus Köln, 5\x80',
				'Content-Type: application/octet-stream; name="März.bin"',
				'',
				'x'
			),
			'latin1'
		);
		const parsed = parseMessage(raw);
		expect(parsed.subject).toBe('Grüße aus Köln, 5€');
		expect(firstFrom(raw)?.name).toBe('Jörg Müller');
		expect(parsed.attachments[0]?.filename).toBe('März.bin');
	});

	it('decodes each header on its own', () => {
		// A latin1 subject does not make a UTF-8 name fall back, nor the reverse.
		const raw = Buffer.concat([
			Buffer.from('From: Jörg <j@example.com>\r\n', 'utf-8'),
			Buffer.from('Subject: Grüße\r\n\r\nx', 'latin1'),
		]);
		expect(parseMessage(raw).subject).toBe('Grüße');
		expect(firstFrom(raw)?.name).toBe('Jörg');
	});
});

describe('byte-order marks in a header', () => {
	/** A message whose Subject, From name and filename are `bytes`. */
	function bomMessage(bytes: number[]): Buffer {
		const value = Buffer.from(bytes);
		return Buffer.concat([
			Buffer.from('Subject: '),
			value,
			Buffer.from('\r\nFrom: "'),
			value,
			Buffer.from(
				'" <a@example.com>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="B"\r\n\r\n--B\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename="'
			),
			value,
			Buffer.from('"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0=\r\n--B--\r\n'),
		]);
	}

	it.each([
		['FF FE (UTF-16LE)', [0xff, 0xfe, 0x41, 0x42], 'ÿþAB'],
		['FE FF (UTF-16BE)', [0xfe, 0xff, 0x41, 0x42], 'þÿAB'],
		['EF BB BF before bytes that are not UTF-8', [0xef, 0xbb, 0xbf, 0x41, 0xe9], 'ï»¿Aé'],
	])('does not let a %s mark pick the encoding', (_mark, bytes, text) => {
		const raw = bomMessage(bytes);
		const parsed = parseMessage(raw);
		expect(parsed.subject).toBe(text);
		expect(firstFrom(raw)?.name).toBe(text);
		expect(parsed.attachments[0]?.filename).toBe(text);
	});

	it('keeps a UTF-8 mark as U+FEFF, which trimming the subject, name and filename removes', () => {
		const bytes = [0xef, 0xbb, 0xbf, 0x41, 0xc3, 0xa9];
		expect(headerBytesToText(bytesToBinaryString(Uint8Array.from(bytes)))).toBe('\ufeffAé');
		const raw = bomMessage(bytes);
		expect(parseMessage(raw).subject).toBe('Aé');
		expect(firstFrom(raw)?.name).toBe('Aé');
		expect(parseMessage(raw).attachments[0]?.filename).toBe('Aé');
	});
});

describe('RFC 2047 encoded words', () => {
	it('still decodes them, across a fold', () => {
		const parsed = parseMessage(
			Buffer.from(
				eml(
					'From: =?UTF-8?Q?J=C3=B6rg?= <j@example.com>',
					'Subject: =?UTF-8?Q?Gr=C3=BC=C3=9Fe?=\r\n =?UTF-8?Q?_aus_K=C3=B6ln?=',
					'',
					'x'
				)
			)
		);
		expect(parsed.subject).toBe('Grüße aus Köln');
		expect((Array.isArray(parsed.from) ? parsed.from[0] : parsed.from)?.value[0]?.name).toBe(
			'Jörg'
		);
	});
});

describe('control characters in decoded subjects and names (#1298)', () => {
	const crlf = Buffer.from('Hello\r\nFrom: x@evil.example', 'utf-8').toString('base64');

	it.each([
		['B', `=?UTF-8?B?${crlf}?=`],
		['Q', '=?UTF-8?Q?Hello=0D=0AFrom=3A_x=40evil.example?='],
	])('turns CR/LF from a %s-encoded subject and name into a space', (_enc, encoded) => {
		const raw = Buffer.from(
			eml(
				`From: ${encoded} <a@example.com>`,
				`To: ${encoded}: b@example.com;`,
				`Subject: ${encoded}`,
				'',
				'x'
			)
		);
		const parsed = parseMessage(raw);
		expect(parsed.subject).toBe('Hello From: x@evil.example');
		expect(firstFrom(raw)?.name).toBe('Hello From: x@evil.example');
		const to = Array.isArray(parsed.to) ? parsed.to[0] : parsed.to;
		expect(to?.value[0]?.name).toBe('Hello From: x@evil.example');
	});

	it('replaces other control characters but keeps TAB', () => {
		const parsed = parseMessage(
			Buffer.from(
				eml(
					'From: =?UTF-8?Q?Eve=00=07_x=09y?= <a@example.com>',
					'Subject: =?UTF-8?Q?a=00b=07_=1B_c=09d=7F?=',
					'',
					'x'
				)
			)
		);
		expect(parsed.subject).toBe('a b c\td');
		expect((Array.isArray(parsed.from) ? parsed.from[0] : parsed.from)?.value[0]?.name).toBe(
			'Eve x\ty'
		);
	});
});

describe('headerBytesToText', () => {
	it('leaves ASCII and decoded text as they are', () => {
		expect(headerBytesToText('=?UTF-8?Q?a?= plain')).toBe('=?UTF-8?Q?a?= plain');
		expect(headerBytesToText('Привет')).toBe('Привет');
	});

	it('reads UTF-8 bytes as UTF-8 and other 8-bit bytes as windows-1252', () => {
		expect(headerBytesToText(bytesToBinaryString(Buffer.from('Köln 😠', 'utf-8')))).toBe('Köln 😠');
		expect(headerBytesToText('K\xf6ln \x80\x99')).toBe('Köln €™');
	});
});

describe('splitHeaderLines', () => {
	it('keeps a trailing byte 0xA0, which is part of a UTF-8 character', () => {
		const binary = bytesToBinaryString(Buffer.from('Subject: Voilà \r\n', 'utf-8'));
		expect(splitHeaderLines(binary).get('subject')).toEqual(['Voil\xc3\xa0']);
	});
});
