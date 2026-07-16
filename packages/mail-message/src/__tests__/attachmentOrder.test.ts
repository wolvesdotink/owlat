import { describe, it, expect } from 'vitest';
import { extractAttachments } from '../parse/attachments';

/**
 * Attachment order is the load-bearing contract shared with the read side:
 * `mailMime.extractAttachments` records `partIndex === String(i)` on stored
 * metadata, so this parser MUST emit attachment leaves in the exact same
 * document order (depth-first, children left-to-right) and with the exact same
 * "is this an attachment" predicate (explicit attachment disposition OR a
 * filename; `multipart/*` never an attachment). These fixtures pin that order.
 */

/** Assemble an eml with CRLF line endings from raw lines. */
const eml = (...lines: string[]): string => lines.join('\r\n');

describe('extractAttachments document order', () => {
	it('flat multipart/mixed: attachments in listed order', () => {
		const raw = eml(
			'Content-Type: multipart/mixed; boundary="B"',
			'',
			'--B',
			'Content-Type: text/plain',
			'',
			'hello body',
			'--B',
			'Content-Type: text/plain; name="a.txt"',
			'Content-Disposition: attachment; filename="a.txt"',
			'',
			'AAAA',
			'--B',
			'Content-Type: application/pdf; name="b.pdf"',
			'Content-Disposition: attachment; filename="b.pdf"',
			'',
			'BBBB',
			'--B--'
		);
		const got = extractAttachments(raw);
		expect(got.map((a) => a.filename)).toEqual(['a.txt', 'b.pdf']);
		expect(got.map((a) => a.contentType)).toEqual(['text/plain', 'application/pdf']);
		// Every attachment carries decoded bytes; partIndex on the read side is
		// simply this array index, so order alone fixes the contract.
		for (const a of got) expect(a.size).toBeGreaterThan(0);
	});

	it('nested tree: depth-first, children left-to-right', () => {
		const raw = eml(
			'Content-Type: multipart/mixed; boundary="OUT"',
			'',
			'--OUT',
			'Content-Type: multipart/alternative; boundary="ALT"',
			'',
			'--ALT',
			'Content-Type: text/plain',
			'',
			'plain',
			'--ALT',
			'Content-Type: text/html',
			'',
			'<p>html</p>',
			'--ALT--',
			'--OUT',
			'Content-Type: application/pdf; name="c.pdf"',
			'Content-Disposition: attachment; filename="c.pdf"',
			'',
			'CCCC',
			'--OUT',
			'Content-Type: multipart/mixed; boundary="INNER"',
			'',
			'--INNER',
			'Content-Type: image/png; name="d.png"',
			'Content-Disposition: attachment; filename="d.png"',
			'',
			'DDDD',
			'--INNER',
			'Content-Type: image/png; name="e.png"',
			'Content-Disposition: attachment; filename="e.png"',
			'',
			'EEEE',
			'--INNER--',
			'--OUT--'
		);
		expect(extractAttachments(raw).map((a) => a.filename)).toEqual(['c.pdf', 'd.png', 'e.png']);
	});

	it('a filename in Content-Type name (no disposition) still counts as an attachment', () => {
		const raw = eml(
			'Content-Type: multipart/mixed; boundary="B"',
			'',
			'--B',
			'Content-Type: text/plain',
			'',
			'body',
			'--B',
			'Content-Type: image/gif; name="named.gif"',
			'',
			'GIFDATA',
			'--B--'
		);
		const got = extractAttachments(raw);
		expect(got.map((a) => a.filename)).toEqual(['named.gif']);
		// No Content-Disposition → defaults to attachment (mailMime parity).
		expect(got[0]!.disposition).toBe('attachment');
	});

	it('an inline part with a filename is an ordered attachment with inline disposition', () => {
		const raw = eml(
			'Content-Type: multipart/related; boundary="R"',
			'',
			'--R',
			'Content-Type: text/html',
			'',
			'<img src="cid:img1">',
			'--R',
			'Content-Type: image/png; name="logo.png"',
			'Content-Disposition: inline; filename="logo.png"',
			'Content-ID: <img1>',
			'',
			'PNGDATA',
			'--R--'
		);
		const got = extractAttachments(raw);
		expect(got.map((a) => a.filename)).toEqual(['logo.png']);
		expect(got[0]!.disposition).toBe('inline');
		expect(got[0]!.contentId).toBe('img1');
	});

	it('a body-only text/plain leaf produces no attachments', () => {
		const raw = eml('Content-Type: text/plain', '', 'just a body, no parts');
		expect(extractAttachments(raw)).toEqual([]);
	});
});
