import { describe, it, expect } from 'vitest';
import { extractAttachments } from '../parse/attachments';
import { transferDecode } from '../parse/body';

const eml = (...lines: string[]): string => lines.join('\r\n');

/**
 * In-package coverage for the attachment decode surface that the cross-package
 * differential (which lives in `@owlat/shared`) exercises but does not attribute
 * coverage to this package: the quoted-printable / malformed-base64 branches of
 * {@link transferDecode}, the `Content-ID` `stripBrackets` path, and the RFC 2231
 * filename-continuation path of the relocated param scanner.
 */
describe('transferDecode', () => {
	it('quoted-printable: `=HH` escapes and soft line breaks decode to raw bytes', () => {
		// `Hello=20World` → "Hello World"; the trailing `=\r\n` is a soft break.
		const bytes = transferDecode('Hello=20World=\r\n!', 'quoted-printable');
		expect(Buffer.from(bytes).toString('latin1')).toBe('Hello World!');
	});

	it('quoted-printable is case-insensitive on the encoding token', () => {
		const bytes = transferDecode('caf=C3=A9', 'Quoted-Printable');
		expect(Buffer.from(bytes).toString('utf-8')).toBe('café');
	});

	it('base64 decodes to raw bytes', () => {
		const bytes = transferDecode('SGVsbG8gQmFzZTY0', 'base64');
		expect(Buffer.from(bytes).toString('latin1')).toBe('Hello Base64');
	});

	it('a malformed base64 body decodes to empty bytes (never throws)', () => {
		expect(() => transferDecode('A', 'base64')).not.toThrow();
		expect([...transferDecode('A', 'base64')]).toEqual([]);
	});
});

describe('extractAttachments decode surface', () => {
	it('decodes a quoted-printable attachment body', () => {
		const raw = eml(
			'Content-Type: multipart/mixed; boundary="B"',
			'',
			'--B',
			'Content-Type: application/octet-stream; name="qp.bin"',
			'Content-Disposition: attachment; filename="qp.bin"',
			'Content-Transfer-Encoding: quoted-printable',
			'',
			'Hello=20World=0A',
			'--B--'
		);
		const [att] = extractAttachments(raw);
		expect(att!.filename).toBe('qp.bin');
		expect(att!.content.toString('latin1')).toBe('Hello World\n');
	});

	it('strips angle brackets from a Content-ID', () => {
		const raw = eml(
			'Content-Type: multipart/related; boundary="R"',
			'',
			'--R',
			'Content-Type: image/png; name="logo.png"',
			'Content-Disposition: inline; filename="logo.png"',
			'Content-ID: <logo-1@example.com>',
			'',
			'PNGDATA',
			'--R--'
		);
		const [att] = extractAttachments(raw);
		expect(att!.contentId).toBe('logo-1@example.com');
		expect(att!.disposition).toBe('inline');
	});

	it('a blank Content-ID yields undefined (not an empty string)', () => {
		const raw = eml(
			'Content-Type: multipart/mixed; boundary="B"',
			'',
			'--B',
			'Content-Type: application/pdf; name="x.pdf"',
			'Content-Disposition: attachment; filename="x.pdf"',
			'Content-ID: <>',
			'',
			'DATA',
			'--B--'
		);
		const [att] = extractAttachments(raw);
		expect(att!.contentId).toBeUndefined();
	});

	it('reassembles an RFC 2231 continued/encoded filename', () => {
		// `filename*0*=utf-8''na%20me; filename*1=.pdf` → "na me.pdf".
		const raw = eml(
			'Content-Type: multipart/mixed; boundary="B"',
			'',
			'--B',
			'Content-Type: application/pdf',
			"Content-Disposition: attachment; filename*0*=utf-8''na%20me; filename*1=.pdf",
			'',
			'DATA',
			'--B--'
		);
		const [att] = extractAttachments(raw);
		expect(att!.filename).toBe('na me.pdf');
	});
});
