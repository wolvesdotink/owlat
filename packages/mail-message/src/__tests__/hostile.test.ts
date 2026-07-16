import { describe, it, expect } from 'vitest';
import { parseBody, parseMimeTree } from '../parse/body';
import { extractAttachments } from '../parse/attachments';

/**
 * Hostile / malformed input must be BOUNDED and must NEVER throw: the walker is
 * depth-capped, a missing boundary yields a childless node, and every decoder
 * is total. These adversarial fixtures assert termination and boundedness, not
 * a specific decoded value.
 */
describe('hostile MIME input', () => {
	it('a 1000-part bomb is bounded and does not throw', () => {
		const parts: string[] = ['Content-Type: multipart/mixed; boundary="B"', ''];
		for (let i = 0; i < 1000; i++) {
			parts.push(
				'--B',
				`Content-Type: application/octet-stream; name="f${i}.bin"`,
				`Content-Disposition: attachment; filename="f${i}.bin"`,
				'',
				`DATA${i}`
			);
		}
		parts.push('--B--');
		const raw = parts.join('\r\n');
		let attachments: ReturnType<typeof extractAttachments> = [];
		expect(() => {
			attachments = extractAttachments(raw);
			parseBody(raw);
		}).not.toThrow();
		expect(attachments).toHaveLength(1000);
		expect(attachments[0]!.filename).toBe('f0.bin');
		expect(attachments[999]!.filename).toBe('f999.bin');
	});

	it('64-deep multipart nesting is bounded and does not throw', () => {
		const depth = 64;
		let raw = 'Content-Type: text/plain\r\n\r\ninner core';
		for (let i = 0; i < depth; i++) {
			const boundary = `B${i}`;
			raw = [
				`Content-Type: multipart/mixed; boundary="${boundary}"`,
				'',
				`--${boundary}`,
				raw,
				`--${boundary}--`,
			].join('\r\n');
		}
		expect(() => {
			parseMimeTree(raw);
			parseBody(raw);
			extractAttachments(raw);
		}).not.toThrow();
	});

	it('a boundary string appearing inside base64 content does not derail the split', () => {
		const raw = [
			'Content-Type: multipart/mixed; boundary="XBOUNDX"',
			'',
			'--XBOUNDX',
			'Content-Type: application/octet-stream; name="a.bin"',
			'Content-Disposition: attachment; filename="a.bin"',
			'Content-Transfer-Encoding: base64',
			'',
			// Payload text mentions the boundary token but not as a delimiter line.
			'VGhpcyBtZW50aW9ucyAtLVhCT1VORFggaW5zaWRl',
			'--XBOUNDX',
			'Content-Type: application/octet-stream; name="b.bin"',
			'Content-Disposition: attachment; filename="b.bin"',
			'',
			'plain',
			'--XBOUNDX--',
		].join('\r\n');
		let attachments: ReturnType<typeof extractAttachments> = [];
		expect(() => {
			attachments = extractAttachments(raw);
		}).not.toThrow();
		expect(attachments.map((a) => a.filename)).toEqual(['a.bin', 'b.bin']);
	});

	it('a headers-only message (no body) does not throw', () => {
		const raw = 'Content-Type: text/plain; charset="utf-8"\r\nSubject: nothing below';
		expect(() => {
			const body = parseBody(raw);
			expect(body.html).toBe(false);
			expect(extractAttachments(raw)).toEqual([]);
		}).not.toThrow();
	});

	it('a multipart with no boundary parameter degrades to an empty tree', () => {
		const raw = 'Content-Type: multipart/mixed\r\n\r\nno boundary here';
		expect(() => {
			expect(extractAttachments(raw)).toEqual([]);
			expect(parseBody(raw).html).toBe(false);
		}).not.toThrow();
	});

	it('mixed CRLF / LF line endings parse without throwing', () => {
		// Deliberately mix \r\n and bare \n at the boundaries and header/body split.
		const raw =
			'Content-Type: multipart/mixed; boundary="B"\n\r\n' +
			'--B\r\n' +
			'Content-Type: text/plain; charset="utf-8"\n\n' +
			'plain part\r\n' +
			'--B\n' +
			'Content-Type: text/html\r\n\r\n' +
			'<p>html part</p>\n' +
			'--B--\r\n';
		expect(() => {
			const body = parseBody(raw);
			expect(typeof body.text === 'string' || body.text === undefined).toBe(true);
			extractAttachments(raw);
		}).not.toThrow();
	});

	it('a truncated message (dangling open boundary, no close) is bounded', () => {
		const raw = [
			'Content-Type: multipart/mixed; boundary="B"',
			'',
			'--B',
			'Content-Type: application/pdf; name="x.pdf"',
			'Content-Disposition: attachment; filename="x.pdf"',
			'',
			'PDFDATA-but-no-closing-boundary',
		].join('\r\n');
		let attachments: ReturnType<typeof extractAttachments> = [];
		expect(() => {
			attachments = extractAttachments(raw);
		}).not.toThrow();
		expect(attachments.map((a) => a.filename)).toEqual(['x.pdf']);
	});
});
