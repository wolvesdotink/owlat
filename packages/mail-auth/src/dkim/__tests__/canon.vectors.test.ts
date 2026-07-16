/**
 * RFC 6376 §3.4 canonicalization vectors.
 *
 * Two kinds of assertion:
 *   1. The literal worked examples from RFC 6376 §3.4.5 — the canonical
 *      relaxed header / relaxed body outputs are pinned byte-for-byte.
 *   2. BYTE-IDENTITY against the `mailauth` oracle (kept as a devDependency,
 *      locked decision D1): for a corpus of bodies, the SHA-256 of our
 *      canonicalized body must equal `mailauth`'s streaming body hash for the
 *      same canonicalization. Equal hashes over adversarial whitespace prove
 *      the canonical bytes match.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { dkimBody } from 'mailauth/lib/dkim/body/index.js';
import {
	canonicalizeBodyRelaxed,
	canonicalizeBodySimple,
	canonicalizeHeaderField,
	parseCanonicalization,
	stripSignatureValue,
} from '../../canon.js';

/** SHA-256 base64 of a buffer — the DKIM body-hash primitive. */
function sha256(buf: Buffer): string {
	return createHash('sha256').update(buf).digest('base64');
}

/** Ask mailauth for the body hash of `body` under a canonicalization. */
function mailauthBodyHash(canon: 'simple' | 'relaxed', body: Buffer): string {
	const hasher = dkimBody(canon) as { update(b: Buffer): void; digest(enc: string): string };
	hasher.update(body);
	return hasher.digest('base64');
}

describe('canonicalizeHeaderField — RFC 6376 §3.4.5 relaxed example', () => {
	it('lowercases the name, unfolds, and collapses WSP', () => {
		// A: X  ->  a:X
		expect(canonicalizeHeaderField('A: X', 'relaxed')).toBe('a:X');
		// "B : Y<TAB><CRLF><TAB>Z  " -> "b:Y Z"
		const folded = 'B : Y\t\r\n\tZ  ';
		expect(canonicalizeHeaderField(folded, 'relaxed')).toBe('b:Y Z');
	});

	it('simple mode returns the field verbatim', () => {
		const folded = 'B : Y\t\r\n\tZ  ';
		expect(canonicalizeHeaderField(folded, 'simple')).toBe(folded);
	});

	it('handles a header with no colon under relaxed', () => {
		expect(canonicalizeHeaderField('Garbage', 'relaxed')).toBe('garbage');
	});
});

describe('canonicalizeBody — RFC 6376 §3.4.5 examples', () => {
	it('relaxed body collapses inner WSP and strips trailing empty lines', () => {
		// " C \r\nD \t E\r\n\r\n\r\n"  ->  " C\r\nD E\r\n"
		const input = Buffer.from(' C \r\nD \t E\r\n\r\n\r\n', 'latin1');
		expect(canonicalizeBodyRelaxed(input).toString('latin1')).toBe(' C\r\nD E\r\n');
	});

	it('relaxed body of an empty body is empty (no CRLF added)', () => {
		expect(canonicalizeBodyRelaxed(Buffer.alloc(0)).length).toBe(0);
		expect(canonicalizeBodyRelaxed(Buffer.from('\r\n\r\n', 'latin1')).length).toBe(0);
	});

	it('simple body of an empty body is a single CRLF', () => {
		expect(canonicalizeBodySimple(Buffer.alloc(0)).toString('latin1')).toBe('\r\n');
	});

	it('simple body collapses only trailing empty lines', () => {
		const input = Buffer.from('Hello\r\n\r\n\r\n', 'latin1');
		expect(canonicalizeBodySimple(input).toString('latin1')).toBe('Hello\r\n');
		// A trailing line that contains a space is NOT empty and is preserved.
		const spaced = Buffer.from('Hello\r\n \r\n', 'latin1');
		expect(canonicalizeBodySimple(spaced).toString('latin1')).toBe('Hello\r\n \r\n');
	});
});

describe('parseCanonicalization', () => {
	it('defaults both halves to simple', () => {
		expect(parseCanonicalization(undefined)).toEqual({ header: 'simple', body: 'simple' });
	});
	it('defaults a missing body half to simple', () => {
		expect(parseCanonicalization('relaxed')).toEqual({ header: 'relaxed', body: 'simple' });
	});
	it('parses both halves', () => {
		expect(parseCanonicalization('relaxed/relaxed')).toEqual({
			header: 'relaxed',
			body: 'relaxed',
		});
	});
});

describe('stripSignatureValue', () => {
	it('empties the b= value but keeps the tag and structure', () => {
		const header = 'DKIM-Signature: v=1; a=rsa-sha256; d=example.com; b=AbCdEf0123==; s=sel';
		const stripped = stripSignatureValue(header);
		expect(stripped).toContain('b=;');
		expect(stripped).not.toContain('AbCdEf0123');
		expect(stripped).toContain('s=sel');
	});

	it('empties a folded b= value spanning multiple lines', () => {
		const header = 'DKIM-Signature: v=1; d=x; b=AAAA\r\n BBBB\r\n CCCC';
		expect(stripSignatureValue(header)).toBe('DKIM-Signature: v=1; d=x; b=');
	});
});

describe('byte-identity vs mailauth body canonicalization (differential)', () => {
	const bodies: ReadonlyArray<{ readonly name: string; readonly body: string }> = [
		{ name: 'plain', body: 'Hello world\r\n' },
		{ name: 'no trailing CRLF', body: 'no newline at end' },
		{ name: 'trailing empty lines', body: 'line one\r\n\r\n\r\n\r\n' },
		{ name: 'inner tabs and spaces', body: 'a\t \tb   c\r\nd  e\r\n' },
		{ name: 'trailing WSP per line', body: 'trailing spaces   \r\nand tabs\t\t\r\n' },
		{ name: 'empty body', body: '' },
		{ name: 'only newlines', body: '\r\n\r\n' },
		{ name: 'mixed content', body: 'Subject line\r\n\r\nParagraph  with   gaps \r\n\r\n' },
	];

	for (const { name, body } of bodies) {
		it(`relaxed body hash matches mailauth: ${name}`, () => {
			const buf = Buffer.from(body, 'latin1');
			expect(sha256(canonicalizeBodyRelaxed(buf))).toBe(mailauthBodyHash('relaxed', buf));
		});

		it(`simple body hash matches mailauth: ${name}`, () => {
			const buf = Buffer.from(body, 'latin1');
			expect(sha256(canonicalizeBodySimple(buf))).toBe(mailauthBodyHash('simple', buf));
		});
	}
});
