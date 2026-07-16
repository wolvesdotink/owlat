import { describe, it, expect } from 'vitest';
import { parseBody, parseMimeTree } from '../parse/body';
import { extractAttachments } from '../parse/attachments';

/**
 * Hostile / malformed input must be BOUNDED and must NEVER throw: the walker is
 * depth-capped, a missing boundary yields a childless node, and every decoder
 * is total. These adversarial fixtures assert termination AND boundedness.
 *
 * `not.toThrow()` wraps ONLY the parse calls — content assertions are hoisted
 * out so a failed expectation reports the real diff rather than an opaque
 * "function threw".
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
		// Within the cap the inner text/plain core is still reachable.
		expect(parseBody(raw).text).toBe('inner core');
	});

	it('120-deep nesting (beyond MAX_DEPTH=100) terminates and degrades to a leaf', () => {
		const depth = 120;
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
		let body: ReturnType<typeof parseBody> | undefined;
		let attachments: ReturnType<typeof extractAttachments> = [];
		expect(() => {
			parseMimeTree(raw);
			body = parseBody(raw);
			attachments = extractAttachments(raw);
		}).not.toThrow();
		// The node AT the depth cap is left unsplit (a raw multipart leaf), so the
		// text/plain core buried below the cap is never reached: it contributes
		// nothing to the body and nothing to attachments.
		expect(body!.text).toBeUndefined();
		expect(body!.html).toBe(false);
		expect(attachments).toEqual([]);
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
		let body: ReturnType<typeof parseBody> | undefined;
		let attachments: ReturnType<typeof extractAttachments> = [];
		expect(() => {
			body = parseBody(raw);
			attachments = extractAttachments(raw);
		}).not.toThrow();
		expect(body!.html).toBe(false);
		expect(attachments).toEqual([]);
	});

	it('a multipart with no boundary parameter degrades to an empty tree', () => {
		const raw = 'Content-Type: multipart/mixed\r\n\r\nno boundary here';
		let body: ReturnType<typeof parseBody> | undefined;
		let attachments: ReturnType<typeof extractAttachments> = [];
		expect(() => {
			body = parseBody(raw);
			attachments = extractAttachments(raw);
		}).not.toThrow();
		expect(attachments).toEqual([]);
		expect(body!.html).toBe(false);
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
		let body: ReturnType<typeof parseBody> | undefined;
		expect(() => {
			body = parseBody(raw);
			extractAttachments(raw);
		}).not.toThrow();
		expect(body!.text).toContain('plain part');
		expect(body!.html).toContain('<p>html part</p>');
	});

	it('a malformed base64 body yields empty content and does not throw', () => {
		// A single stray base64 char (`A`) cannot decode to whole bytes; `atob`
		// throws internally and the decoder must swallow it into empty content
		// rather than aborting extraction of the message. (mailMime parity.)
		const raw = [
			'Content-Type: multipart/mixed; boundary="B"',
			'',
			'--B',
			'Content-Type: application/octet-stream; name="bad.bin"',
			'Content-Disposition: attachment; filename="bad.bin"',
			'Content-Transfer-Encoding: base64',
			'',
			'A',
			'--B--',
		].join('\r\n');
		let attachments: ReturnType<typeof extractAttachments> = [];
		expect(() => {
			attachments = extractAttachments(raw);
			parseBody(raw);
		}).not.toThrow();
		expect(attachments.map((a) => a.filename)).toEqual(['bad.bin']);
		expect(attachments[0]!.size).toBe(0);
		expect([...attachments[0]!.content]).toEqual([]);
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
