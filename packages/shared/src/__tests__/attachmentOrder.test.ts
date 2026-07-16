import { describe, it, expect } from 'vitest';
import { extractAttachments } from '@owlat/mail-message';
import { extractAttachments as oracleExtract } from '../mailMime';

/**
 * Attachment order is the load-bearing contract shared with the read side:
 * `@owlat/shared/mailMime.extractAttachments` records `partIndex === String(i)`
 * on stored metadata, so the in-house `@owlat/mail-message` parser MUST emit
 * attachment leaves in the exact same document order (depth-first, children
 * left-to-right) and with the exact same "is this an attachment" predicate.
 *
 * This is a DIFFERENTIAL against that named oracle: every fixture is run through
 * BOTH extractors and their outputs are asserted equal on filename order,
 * contentType, disposition, contentId and decoded bytes. Hand-computed
 * expectations alone can't catch a shared misreading of the mailMime predicate;
 * pinning to the oracle can.
 *
 * It lives in `@owlat/shared` (which already prod-depends on
 * `@owlat/mail-message` via the `/headers` re-export shim) rather than in
 * `@owlat/mail-message` itself, so the live oracle is importable next to the new
 * extractor with ZERO new package edges — a devDependency the other direction
 * would form a `mail-message <-> shared` build cycle.
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
		// partIndex contract silently drops the part. (Round-1 Blocking 3.)
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

	it('malformed Content-Type (no semicolon before boundary) is a multipart with indexed parts on BOTH sides', () => {
		// The same broken-generator shape on the CONTAINER: `multipart/mixed
		// boundary="B"` with no separating `;`. mailMime's `getBoundary` reads it
		// via the whitespace-anchored scan, so the container is a real multipart
		// with indexed attachments — the new walker must read the boundary the same
		// way or the WHOLE message degrades to an inert leaf with zero attachments,
		// silently breaking the stored partIndex contract. (Round-2 Blocking 2.)
		const raw = eml(
			'Content-Type: multipart/mixed boundary="B"',
			'',
			'--B',
			'Content-Type: text/plain',
			'',
			'body',
			'--B',
			'Content-Type: application/pdf; name="nosemi.pdf"',
			'Content-Disposition: attachment; filename="nosemi.pdf"',
			'',
			'NOSEMI',
			'--B--'
		);
		expectParity(raw, ['nosemi.pdf']);
	});

	it('a body-only text/plain leaf produces no attachments', () => {
		const raw = eml('Content-Type: text/plain', '', 'just a body, no parts');
		expectParity(raw, []);
	});

	it('duplicate part Content-Type: LAST occurrence wins on BOTH sides', () => {
		// mailMime.parseHeaders builds its map with `map.set` per line, so a repeated
		// MIME header collapses to the LAST occurrence. The new walker reads the four
		// MIME headers via `MessageHeaders.last`, so a part carrying two Content-Type
		// headers resolves to the second (`application/pdf; name="x.pdf"`) on both
		// sides — a classic duplicate-header MIME-confusion divergence, now aligned.
		// (Round-3 Blocking 1.)
		const raw = eml(
			'Content-Type: multipart/mixed; boundary="B"',
			'',
			'--B',
			'Content-Type: text/plain',
			'Content-Type: application/pdf; name="x.pdf"',
			'',
			'DATA',
			'--B--'
		);
		expectParity(raw, ['x.pdf']);
	});

	it('duplicate ROOT Content-Type: LAST occurrence wins (text/plain then multipart)', () => {
		// The root carries text/plain THEN multipart/mixed; last-wins makes it a real
		// container on both sides, so the nested attachment is found. (Round-3
		// Blocking 1.)
		const raw = eml(
			'Content-Type: text/plain',
			'Content-Type: multipart/mixed; boundary="B"',
			'',
			'--B',
			'Content-Type: application/pdf; name="nested.pdf"',
			'Content-Disposition: attachment; filename="nested.pdf"',
			'',
			'DATA',
			'--B--'
		);
		expectParity(raw, ['nested.pdf']);
	});

	it('duplicate Content-Disposition: LAST occurrence wins (inline then attachment)', () => {
		// inline THEN attachment; filename="z.bin" → last-wins yields an attachment
		// with filename z.bin on both sides. (Round-3 Blocking 1.)
		const raw = eml(
			'Content-Type: multipart/mixed; boundary="B"',
			'',
			'--B',
			'Content-Type: application/octet-stream',
			'Content-Disposition: inline',
			'Content-Disposition: attachment; filename="z.bin"',
			'',
			'DATA',
			'--B--'
		);
		expectParity(raw, ['z.bin']);
	});

	it('slashless `multipart` with a boundary is ONE leaf attachment, not a container', () => {
		// mailMime gates splitting on `mainType.startsWith('multipart/')`, which is
		// FALSE for a slashless `Content-Type: multipart`. So the whole part — despite
		// carrying a `boundary` and inner `--B` delimiters — is a single leaf
		// attachment (`whole.eml`), never split into the inner part. The new walker
		// gates on `value.startsWith('multipart/')` to match. (Round-3 Blocking 2.)
		const raw = eml(
			'Content-Type: multipart; boundary="B"',
			'Content-Disposition: attachment; filename="whole.eml"',
			'',
			'--B',
			'Content-Type: application/pdf; name="inner.pdf"',
			'Content-Disposition: attachment; filename="inner.pdf"',
			'',
			'DATA',
			'--B--'
		);
		expectParity(raw, ['whole.eml']);
	});

	it('slashless `multipart` with a filename and no boundary is a leaf attachment', () => {
		// Slashless `multipart` + filename, no boundary → NOT a container (so not
		// excluded by the multipart guard) and IS an attachment via its filename.
		// (Round-3 Blocking 2.)
		const raw = eml(
			'Content-Type: multipart; name="odd.bin"',
			'Content-Disposition: attachment; filename="odd.bin"',
			'',
			'ODDDATA'
		);
		expectParity(raw, ['odd.bin']);
	});

	it('quoted-printable and base64 attachment bytes match the oracle decoder', () => {
		// `expectParity` compares decoded bytes, so this pins transferDecode's QP and
		// base64 branches to mailMime's decoder byte-for-byte. (Round-3 Improvement 1.)
		const raw = eml(
			'Content-Type: multipart/mixed; boundary="B"',
			'',
			'--B',
			'Content-Type: application/octet-stream; name="qp.bin"',
			'Content-Disposition: attachment; filename="qp.bin"',
			'Content-Transfer-Encoding: quoted-printable',
			'',
			'Hello=20World=0A',
			'--B',
			'Content-Type: application/octet-stream; name="b64.bin"',
			'Content-Disposition: attachment; filename="b64.bin"',
			'Content-Transfer-Encoding: base64',
			'',
			'SGVsbG8gQmFzZTY0',
			'--B--'
		);
		expectParity(raw, ['qp.bin', 'b64.bin']);
	});

	it('an RFC 2231 continued/encoded filename decodes identically on both sides', () => {
		// `filename*0*=utf-8''na%20me; filename*1=.pdf` → "na me.pdf" — exercises the
		// continuation path of the relocated `getRawParam`. (Round-3 Improvement 4.)
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
		expectParity(raw, ['na me.pdf']);
	});
});
