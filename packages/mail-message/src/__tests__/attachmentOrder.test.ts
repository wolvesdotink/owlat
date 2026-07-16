import { describe, it, expect } from 'vitest';
import { extractAttachments } from '../parse/attachments';
import { extractAttachments as oracleExtract } from '@owlat/shared/mailMime';

/**
 * Attachment order is the load-bearing contract shared with the read side:
 * `@owlat/shared/mailMime.extractAttachments` records `partIndex === String(i)`
 * on stored metadata, so this parser MUST emit attachment leaves in the exact
 * same document order (depth-first, children left-to-right) and with the exact
 * same "is this an attachment" predicate.
 *
 * This is a DIFFERENTIAL against that named oracle: every fixture is run through
 * BOTH extractors and their outputs are asserted equal on filename order,
 * contentType, disposition, contentId and decoded bytes. Hand-computed
 * expectations alone can't catch a shared misreading of the mailMime predicate;
 * pinning to the oracle can.
 */

/** Assemble an eml with CRLF line endings from raw lines. */
const eml = (...lines: string[]): string => lines.join('\r\n');

/**
 * Assert that the new extractor matches `mailMime.extractAttachments` on every
 * observable field, and (when given) that the filename order is the expected one
 * — so a bug that moved BOTH sides identically still fails on `expectedNames`.
 */
function expectParity(raw: string, expectedNames?: string[]): void {
	const got = extractAttachments(raw);
	const oracle = oracleExtract(raw);

	expect(got.map((a) => a.filename)).toEqual(oracle.map((a) => a.filename));
	expect(got.map((a) => a.contentType)).toEqual(oracle.map((a) => a.contentType));
	expect(got.map((a) => a.disposition)).toEqual(oracle.map((a) => a.disposition));
	expect(got.map((a) => a.contentId ?? null)).toEqual(oracle.map((a) => a.contentId ?? null));
	expect(got.map((a) => [...a.content])).toEqual(oracle.map((a) => [...a.bytes]));

	if (expectedNames !== undefined) {
		expect(got.map((a) => a.filename)).toEqual(expectedNames);
	}
}

describe('extractAttachments document order (differential vs mailMime)', () => {
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
		expectParity(raw, ['a.txt', 'b.pdf']);
		// partIndex on the read side is simply this array index.
		for (const a of extractAttachments(raw)) expect(a.size).toBeGreaterThan(0);
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
		expectParity(raw, ['c.pdf', 'd.png', 'e.png']);
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
		expectParity(raw, ['named.gif']);
		// No Content-Disposition → defaults to attachment (mailMime parity).
		expect(extractAttachments(raw)[0]!.disposition).toBe('attachment');
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
		expectParity(raw, ['logo.png']);
		const got = extractAttachments(raw);
		expect(got[0]!.disposition).toBe('inline');
		expect(got[0]!.contentId).toBe('img1');
	});

	it('malformed Content-Disposition (no semicolon before filename) is an attachment on BOTH sides', () => {
		// Real broken generators emit `attachment filename="x"` with no separating
		// `;`. mailMime matches it via `startsWith('attachment')` + a whitespace-
		// anchored param scan, so the new extractor must too or the stored
		// partIndex contract silently drops the part. (Blocking 3.)
		const raw = eml(
			'Content-Type: multipart/mixed; boundary="B"',
			'',
			'--B',
			'Content-Type: text/plain',
			'',
			'body',
			'--B',
			'Content-Type: application/octet-stream',
			'Content-Disposition: attachment filename="broken.bin"',
			'',
			'BROKEN',
			'--B--'
		);
		expectParity(raw, ['broken.bin']);
	});

	it('a body-only text/plain leaf produces no attachments', () => {
		const raw = eml('Content-Type: text/plain', '', 'just a body, no parts');
		expectParity(raw, []);
	});
});
