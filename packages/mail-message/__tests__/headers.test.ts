/**
 * RFC 2047 header-encoding coverage, moved out of the Convex postbox .eml
 * builder (`apps/api/convex/mail/__tests__/rfc822.test.ts`, audit item PR-50)
 * when the helpers moved into `@owlat/mail-message`. Assertions are unchanged;
 * the two former DraftRow integration cases now build via the package's neutral
 * `ComposeInput` instead of the Convex row.
 *
 * PR-50 — Headers/MIME nits in the postbox .eml builder:
 *   (1) encodeHeaderValue emitted a SINGLE `=?UTF-8?B?…?=` encoded-word for a
 *       non-ASCII value, which can exceed the RFC 2047 §2 75-octet encoded-word
 *       cap and the RFC 5322 §2.2.3 998-octet line cap. It must now chunk into
 *       multiple <=75-octet encoded-words folded with CRLF+SP that decode back
 *       to the original value (RFC 2047 §5, §6.2).
 *   (3) From / To / Cc display-name phrases were CRLF-stripped but not RFC 2047
 *       encoded, so a non-ASCII display name shipped raw 8-bit. They must now be
 *       address-aware encoded: phrase RFC-2047 encoded, addr-spec left literal
 *       (RFC 5322 §3.4, RFC 2047 §5).
 */

import { describe, it, expect } from 'vitest';
import {
	buildRfc822,
	encodeHeaderValue,
	encodeAddressHeader,
	type ComposeInput,
} from '../src/index';

function makeInput(overrides: Partial<ComposeInput> = {}): ComposeInput {
	return {
		toAddresses: ['rcpt@example.com'],
		ccAddresses: [],
		bccAddresses: [],
		fromAddress: 'sender@owlat.test',
		subject: 'Weekly update',
		bodyHtml: '<p>Hello</p>',
		bodyText: 'Hello',
		...overrides,
	};
}

/** First-line-up-to-blank-line header block of the raw .eml. */
function headerBlock(raw: Buffer): string {
	return raw.toString('utf-8').split('\r\n\r\n')[0]!;
}

/** Split on CRLF only — a correctly wrapped message must contain no bare LF/CR. */
function crlfLines(eml: string): string[] {
	return eml.split('\r\n');
}

/**
 * Decode a folded RFC 2047 header value back to its original string. Adjacent
 * encoded-words separated only by folding white space (CRLF + SP) concatenate
 * with the whitespace dropped (RFC 2047 §6.2), so we strip the folds first,
 * then base64-decode each `=?UTF-8?B?…?=` word and join.
 */
function decodeRfc2047(value: string): string {
	const unfolded = value.replace(/\r\n[ \t]+/g, '');
	const wordRe = /=\?UTF-8\?B\?([^?]*)\?=/gi;
	let out = '';
	let lastEnd = 0;
	let m: RegExpExecArray | null;
	while ((m = wordRe.exec(unfolded)) !== null) {
		out += unfolded.slice(lastEnd, m.index);
		out += Buffer.from(m[1]!, 'base64').toString('utf-8');
		lastEnd = m.index + m[0].length;
	}
	out += unfolded.slice(lastEnd);
	return out;
}

describe('encodeHeaderValue folding (RFC 2047 §2/§5, RFC 5322 §2.2.3)', () => {
	it('splits a very long non-ASCII subject into multiple <=75-char encoded-words folded by CRLF+SP', () => {
		const subject = 'ü'.repeat(200);
		const encoded = encodeHeaderValue(subject);

		// Folded across multiple encoded-words joined by CRLF + a single space.
		const segments = encoded.split('\r\n ');
		expect(segments.length).toBeGreaterThan(1);

		// Every encoded-word is well-formed and within the 75-octet RFC 2047 cap.
		for (const seg of segments) {
			expect(seg).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/]+=*\?=$/);
			expect(Buffer.byteLength(seg, 'utf-8')).toBeLessThanOrEqual(75);
		}

		// Decodes back to the exact original value (no split multi-byte chars).
		expect(decodeRfc2047(encoded)).toBe(subject);
	});

	it('leaves a plain-ASCII subject unchanged (no encoded-word)', () => {
		expect(encodeHeaderValue('Weekly update')).toBe('Weekly update');
	});

	it('wraps an over-long non-ASCII subject so the rendered Subject line stays under 998 octets', () => {
		const subject = 'ü'.repeat(200);
		const { raw } = buildRfc822(
			makeInput({ subject }),
			[],
			'<id@owlat.test>',
			undefined,
			undefined
		);
		const eml = raw.toString('utf-8');
		// Every CRLF-delimited physical line — including the folded Subject
		// continuation lines — is within the RFC 5322 §2.1.1 998-octet limit.
		for (const line of crlfLines(eml)) {
			expect(Buffer.byteLength(line, 'utf-8')).toBeLessThanOrEqual(998);
		}
		// And the value still round-trips out of the header block.
		const subjectHeader = headerBlock(raw)
			.split('\r\n')
			.reduce<string[]>((acc, line) => {
				if (line.startsWith('Subject: ')) acc.push(line.slice('Subject: '.length));
				else if (acc.length > 0 && /^[ \t]/.test(line)) acc[acc.length - 1] += '\r\n' + line;
				return acc;
			}, [])[0]!;
		expect(decodeRfc2047(subjectHeader)).toBe(subject);
	});
});

describe('encodeAddressHeader (RFC 5322 §3.4, RFC 2047 §5)', () => {
	it('RFC-2047-encodes a non-ASCII display name and leaves the addr-spec literal', () => {
		const encoded = encodeAddressHeader(['Müller <m@x.test>']);
		// Pure-ASCII output (the whole point of 2047 word-encoding).
		// eslint-disable-next-line no-control-regex
		expect(/^[\x00-\x7F]*$/.test(encoded)).toBe(true);
		// Phrase is an encoded-word; addr-spec is verbatim with its brackets.
		expect(encoded).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/]+=*\?= <m@x\.test>$/);
		// The phrase decodes back to the original display name.
		const phrase = encoded.slice(0, encoded.lastIndexOf(' <'));
		expect(decodeRfc2047(phrase)).toBe('Müller');
		// The literal addr-spec was NOT encoded.
		expect(encoded).toContain('<m@x.test>');
	});

	it('leaves an ASCII display name and a bare addr-spec unchanged', () => {
		expect(encodeAddressHeader(['Alice <a@x.test>'])).toBe('Alice <a@x.test>');
		expect(encodeAddressHeader(['plain@x.test'])).toBe('plain@x.test');
	});

	it('joins a multi-recipient list with ", " and encodes each phrase independently', () => {
		const encoded = encodeAddressHeader(['Müller <m@x.test>', 'plain@y.test']);
		const [first, second] = encoded.split(', ');
		expect(second).toBe('plain@y.test');
		expect(first).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/]+=*\?= <m@x\.test>$/);
	});

	it('produces a pure-ASCII From header for a non-ASCII display name in a built message', () => {
		const { raw } = buildRfc822(
			makeInput({ fromAddress: 'Müller <m@x.test>' }),
			[],
			'<id@owlat.test>',
			undefined,
			undefined
		);
		const headers = headerBlock(raw);
		const fromLine = headers.split('\r\n').find((l) => l.startsWith('From: '))!;
		// eslint-disable-next-line no-control-regex
		expect(/^[\x00-\x7F]*$/.test(fromLine)).toBe(true);
		expect(fromLine).toContain('=?UTF-8?');
		expect(fromLine).toContain('<m@x.test>');
		// The raw non-ASCII display name never appears verbatim on the wire.
		expect(headers).not.toContain('Müller');
	});
});
