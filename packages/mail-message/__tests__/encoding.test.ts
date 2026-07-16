/**
 * RFC 2045 body-encoding coverage, moved out of the Convex postbox .eml builder
 * (`apps/api/convex/mail/__tests__/rfc822.test.ts`, audit item PR-49) when the
 * helpers moved into `@owlat/mail-message`. Assertions are unchanged — they now
 * exercise the package's `encodeTextBody` / `quotedPrintableEncode` directly.
 */

import { describe, it, expect } from 'vitest';
import { encodeTextBody, quotedPrintableEncode } from '../src/index';

describe('encodeTextBody', () => {
	it('CRLF-normalizes bare LF in a 7bit body', () => {
		const { cte, encoded } = encodeTextBody('line one\nline two\nline three');
		expect(cte).toBe('7bit');
		expect(encoded).toBe('line one\r\nline two\r\nline three');
		expect(encoded).not.toMatch(/(?<!\r)\n/);
	});

	it('falls back to quoted-printable when an ASCII line exceeds 998 octets', () => {
		const { cte, encoded } = encodeTextBody('x'.repeat(2000));
		expect(cte).toBe('quoted-printable');
		for (const line of encoded.split('\r\n')) {
			expect(line.length).toBeLessThanOrEqual(76);
		}
	});

	it('selects quoted-printable for non-ASCII input', () => {
		const { cte } = encodeTextBody('héllo');
		expect(cte).toBe('quoted-printable');
	});
});

describe('quotedPrintableEncode (RFC 2045 §6.7)', () => {
	it('escapes "=" and non-ASCII octets and keeps lines <=76', () => {
		const out = quotedPrintableEncode('a=b ünïcödé ' + 'z'.repeat(200));
		expect(out).toContain('=3D'); // '=' escaped
		expect(out).toContain('=C3=BC'); // 'ü' in UTF-8
		for (const line of out.split('\r\n')) {
			expect(line.length).toBeLessThanOrEqual(76);
		}
	});

	it('canonicalises bare LF/CR to CRLF hard breaks', () => {
		const out = quotedPrintableEncode('héllo\nwörld\ragain');
		expect(out).not.toMatch(/(?<!\r)\n/);
		expect(out).not.toMatch(/\r(?!\n)/);
	});

	it('encodes trailing whitespace at end of a line', () => {
		const out = quotedPrintableEncode('héllo \nworld');
		// Trailing space before the hard break must be encoded as =20.
		expect(out).toContain('=20\r\n');
	});

	it('never leaves a literal space/tab before a soft line break (RFC 2045 §6.7 rule 3)', () => {
		// A long single-line space-delimited body — the exact PR-49 input — forces
		// many soft-wrap folds. Folding must not push a literal space/tab to the end
		// of a folded line right before the '=', or whitespace-trimming relays strip
		// it and corrupt the body / break DKIM.
		const body = 'word '.repeat(300).trim();
		const out = quotedPrintableEncode(body);
		const lines = out.split('\r\n');
		const softBreakLines = lines.filter((l) => l.endsWith('='));
		// Sanity: the input really did fold (otherwise the assertion is vacuous).
		expect(softBreakLines.length).toBeGreaterThan(1);
		for (const line of softBreakLines) {
			expect(line).not.toMatch(/[ \t]=$/);
		}
	});

	it('folds the same way for a tab-delimited body without a literal tab before a soft break', () => {
		const body = 'word\t'.repeat(300).trim();
		const out = quotedPrintableEncode(body);
		const lines = out.split('\r\n');
		const softBreakLines = lines.filter((l) => l.endsWith('='));
		expect(softBreakLines.length).toBeGreaterThan(1);
		for (const line of softBreakLines) {
			expect(line).not.toMatch(/[ \t]=$/);
		}
	});

	it('keeps every physical line <=76 octets even when escaping whitespace before a soft break', () => {
		// Whitespace->'=20' rewrite grows a folded line by 2 octets; the fold
		// threshold must reserve room so the physical line never exceeds 76.
		const body = 'word '.repeat(500).trim();
		const out = quotedPrintableEncode(body);
		for (const line of out.split('\r\n')) {
			expect(Buffer.byteLength(line, 'utf-8')).toBeLessThanOrEqual(76);
		}
	});
});
