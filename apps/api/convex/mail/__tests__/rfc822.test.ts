/**
 * Postbox .eml builder regression coverage (audit items PR-49 + PR-52).
 *
 * PR-52 — RFC 5322 header behaviour (domain Headers/MIME):
 *   (1) Exactly one well-formed `Message-ID:` header, domain-scoped to the
 *       From address, and globally unique across generated drafts
 *       (RFC 5322 §3.6.4).
 *   (2) The `To:` header is non-empty and reflects the draft recipients
 *       (RFC 5322 §3.6.3).
 *   (3) `Bcc` recipients are suppressed from the header block — they ride the
 *       transport envelope only, never the message headers (RFC 5322 §3.6.3).
 *   The Message-ID generator (`buildMessageId`) is the same function
 *   `outbound.ts` calls at dispatch time: `domain = fromAddress.split('@')[1]`,
 *   then the id is passed straight into `buildRfc822`.
 *
 * PR-49 — MIME wire-correctness:
 *   Regression guard for the gap where the postbox .eml builder hardcoded
 *   `Content-Transfer-Encoding: 8bit` and dropped the renderer's single-line
 *   HTML body in verbatim. A long render (renderEmailHtml emits the whole body
 *   on one line) therefore produced a >998-octet line — over the RFC 5322
 *   §2.1.1 hard limit — which MTAs may reject or silently re-fold (breaking
 *   DKIM), and 8bit corrupts on non-8BITMIME relays (RFC 6152). A non-ASCII
 *   body shipped as raw 8bit for the same reason. The builder must now
 *   CRLF-normalize, keep every line <=998 octets, and choose a transfer-encoding
 *   (7bit / quoted-printable) — never 8bit.
 */

import { describe, it, expect } from 'vitest';
import { renderEmailHtml } from '@owlat/email-renderer';
import {
	buildRfc822,
	buildMessageId,
	encodeHeaderValue,
	encodeAddressHeader,
	encodeTextBody,
	quotedPrintableEncode,
	type DraftRow,
} from '../rfc822';

function makeDraft(overrides: Partial<DraftRow> = {}): DraftRow {
	return {
		_id: 'draft1' as DraftRow['_id'],
		mailboxId: 'mailbox1' as DraftRow['mailboxId'],
		toAddresses: ['rcpt@example.com'],
		ccAddresses: [],
		bccAddresses: [],
		fromAddress: 'sender@owlat.test',
		subject: 'Weekly update',
		bodyHtml: '<p>Hello</p>',
		bodyText: 'Hello',
		state: 'pending_send',
		attachments: [],
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
	// Unfold: a CRLF followed by WSP is folding white space; between two
	// encoded-words it is dropped entirely on decode.
	const unfolded = value.replace(/\r\n[ \t]+/g, '');
	const wordRe = /=\?UTF-8\?B\?([^?]*)\?=/gi;
	let out = '';
	let lastEnd = 0;
	let m: RegExpExecArray | null;
	while ((m = wordRe.exec(unfolded)) !== null) {
		// Any literal (non-encoded) text between words is kept verbatim.
		out += unfolded.slice(lastEnd, m.index);
		out += Buffer.from(m[1]!, 'base64').toString('utf-8');
		lastEnd = m.index + m[0].length;
	}
	out += unfolded.slice(lastEnd);
	return out;
}

describe('buildRfc822 — Message-ID (RFC 5322 §3.6.4)', () => {
	it('emits exactly one Message-ID header, domain-scoped to the From address', () => {
		const fromAddress = 'alice@acme.test';
		const domain = fromAddress.split('@')[1]!;
		const rfc822MessageId = buildMessageId(domain);

		const { raw } = buildRfc822(
			makeDraft({ fromAddress }),
			[],
			rfc822MessageId,
			undefined,
			undefined,
		);
		const eml = raw.toString('utf-8');

		// Anchored at the very start of the message: `Message-ID` is the first
		// header line, the value is `<local.hex@domain>`, terminated by CRLF.
		expect(eml).toMatch(
			/^Message-ID: <[0-9a-z]+\.[0-9a-f]{12}@acme\.test>\r\n/,
		);

		// Exactly one Message-ID header — no accidental duplication from the
		// threading (In-Reply-To/References) branch.
		const occurrences = eml.match(/^Message-ID: /gm) ?? [];
		expect(occurrences.length).toBe(1);
	});

	it('generates globally-unique Message-IDs across 10000 drafts', () => {
		const ids = new Set<string>();
		for (let i = 0; i < 10_000; i++) {
			ids.add(buildMessageId('acme.test'));
		}
		expect(ids.size).toBe(10_000);
	});
});

describe('buildRfc822 — To / Bcc (RFC 5322 §3.6.3)', () => {
	it('renders a non-empty To header and never leaks Bcc into the header block', () => {
		const { raw } = buildRfc822(
			makeDraft({
				toAddresses: ['a@x.test'],
				bccAddresses: ['secret@y.test'],
			}),
			[],
			'<id@acme.test>',
			undefined,
			undefined,
		);
		const headers = headerBlock(raw);

		// To is present and carries the visible recipient.
		expect(headers).toMatch(/^To: a@x\.test\r?$/m);

		// No Bcc header, and the bcc address never appears anywhere in the
		// header block — it rides the transport envelope only.
		expect(headers).not.toMatch(/^Bcc:/mi);
		expect(headers).not.toContain('secret@y.test');
	});
});

describe('buildRfc822 line wrapping (RFC 5322 §2.1.1)', () => {
	it('wraps a 3000+ char renderEmailHtml body so every CRLF line is <=998 octets with no bare LF/CR', () => {
		// renderEmailHtml emits the whole body on a single line — a long body is
		// thousands of octets wide before encoding.
		const longBody = 'lorem ipsum dolor sit amet '.repeat(200); // ~5400 chars
		expect(longBody.length).toBeGreaterThan(3000);
		const html = renderEmailHtml([
			{ id: 'b', type: 'text', content: { html: `<p>${longBody}</p>` } } as never,
		]);
		// Sanity: the raw render really is one over-long line (the bug input).
		expect(Math.max(...html.split('\n').map((l) => Buffer.byteLength(l, 'utf-8')))).toBeGreaterThan(998);

		const { raw } = buildRfc822(
			makeDraft({ bodyHtml: html, bodyText: undefined }),
			[],
			'<id@owlat.test>',
			undefined,
			undefined,
		);
		const eml = raw.toString('utf-8');

		// No bare LF or CR — every newline is a CRLF pair.
		expect(eml).not.toMatch(/\r(?!\n)/); // CR not followed by LF
		expect(eml).not.toMatch(/(?<!\r)\n/); // LF not preceded by CR

		// Every CRLF-delimited line is within the 998-octet hard limit.
		for (const line of crlfLines(eml)) {
			expect(Buffer.byteLength(line, 'utf-8')).toBeLessThanOrEqual(998);
		}
	});

	it('does not emit Content-Transfer-Encoding: 8bit for a long body', () => {
		const longBody = 'a'.repeat(4000);
		const html = renderEmailHtml([
			{ id: 'b', type: 'text', content: { html: `<p>${longBody}</p>` } } as never,
		]);
		const { raw } = buildRfc822(
			makeDraft({ bodyHtml: html, bodyText: undefined }),
			[],
			'<id@owlat.test>',
			undefined,
			undefined,
		);
		const eml = raw.toString('utf-8');
		expect(eml).not.toContain('Content-Transfer-Encoding: 8bit');
	});
});

describe('buildRfc822 transfer-encoding choice (RFC 2045 §6.7, RFC 6152)', () => {
	it('uses quoted-printable or base64 — never 8bit — for a non-ASCII body', () => {
		const nonAscii = '<p>Grüße aus München — café ☕ naïve façade — Привет</p>';
		const { raw } = buildRfc822(
			makeDraft({ bodyHtml: nonAscii, bodyText: undefined }),
			[],
			'<id@owlat.test>',
			undefined,
			undefined,
		);
		const eml = raw.toString('utf-8');

		expect(eml).not.toContain('Content-Transfer-Encoding: 8bit');
		expect(eml).toMatch(/Content-Transfer-Encoding: (quoted-printable|base64)/);
		// The raw non-ASCII octets must not appear verbatim in the body.
		expect(eml).not.toContain('München');
	});

	it('keeps a plain-ASCII short body as 7bit and readable', () => {
		const { raw } = buildRfc822(
			makeDraft({ bodyHtml: '<p>Hello world</p>', bodyText: undefined }),
			[],
			'<id@owlat.test>',
			undefined,
			undefined,
		);
		const eml = raw.toString('utf-8');
		expect(eml).toContain('Content-Transfer-Encoding: 7bit');
		expect(eml).toContain('<p>Hello world</p>');
		expect(eml).not.toContain('Content-Transfer-Encoding: 8bit');
	});
});

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

/**
 * PR-50 — Headers/MIME nits in the postbox .eml builder (domain Headers/MIME):
 *
 *   (1) encodeHeaderValue emitted a SINGLE `=?UTF-8?B?…?=` encoded-word for a
 *       non-ASCII value, which can exceed the RFC 2047 §2 75-octet encoded-word
 *       cap and the RFC 5322 §2.2.3 998-octet line cap. It must now chunk into
 *       multiple <=75-octet encoded-words folded with CRLF+SP that decode back
 *       to the original value (RFC 2047 §5, §6.2).
 *   (2) The Date header used `toUTCString()` -> obsolete `GMT` zone. It must
 *       emit the numeric `+0000` zone (RFC 5322 §3.3).
 *   (3) From / To / Cc display-name phrases were CRLF-stripped but not RFC 2047
 *       encoded, so a non-ASCII display name shipped raw 8-bit. They must now be
 *       address-aware encoded: phrase RFC-2047 encoded, addr-spec left literal
 *       (RFC 5322 §3.4, RFC 2047 §5).
 */
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
			makeDraft({ subject }),
			[],
			'<id@owlat.test>',
			undefined,
			undefined,
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

describe('buildRfc822 line length for a huge ASCII subject (RFC 5322 §2.1.1)', () => {
	it('keeps every line <=998 octets even with a 2000-char ASCII subject', () => {
		// A whitespace-free 2000-char ASCII subject can't fold on folding white
		// space, so the builder must route it through encoded-word folding to keep
		// the rendered Subject line (and every physical line) within the 998-octet
		// hard limit — including the Subject line itself.
		const subject = 'x'.repeat(2000);
		const { raw } = buildRfc822(
			makeDraft({ subject }),
			[],
			'<id@owlat.test>',
			undefined,
			undefined,
		);
		const eml = raw.toString('utf-8');
		// No bare CR/LF — every newline is a CRLF pair.
		expect(eml).not.toMatch(/\r(?!\n)/);
		expect(eml).not.toMatch(/(?<!\r)\n/);
		// EVERY physical line — Subject continuation lines included — stays within
		// the 998-octet hard limit.
		for (const line of crlfLines(eml)) {
			expect(Buffer.byteLength(line, 'utf-8')).toBeLessThanOrEqual(998);
		}
		// The folded ASCII Subject still round-trips back to the original value.
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

describe('buildRfc822 Date header (RFC 5322 §3.3)', () => {
	it('emits a numeric +0000 zone (not the obsolete GMT) and round-trips within 2s', () => {
		const before = Date.now();
		const { raw } = buildRfc822(
			makeDraft(),
			[],
			'<id@owlat.test>',
			undefined,
			undefined,
		);
		const after = Date.now();
		const headers = headerBlock(raw);

		const dateLine = headers.split('\r\n').find((l) => l.startsWith('Date: '))!;
		expect(dateLine).toBeDefined();
		expect(dateLine).not.toContain('GMT');
		// The line ends with the numeric zone followed by CRLF (the header block is
		// CRLF-joined, so assert against the rendered header value + terminator).
		const dateValue = dateLine.slice('Date: '.length);
		expect(`${dateValue}\r\n`).toMatch(/\+0000\r\n$/);

		// Parses to a real instant within the call window (allow 2s of slack).
		const parsed = Date.parse(dateValue);
		expect(Number.isNaN(parsed)).toBe(false);
		expect(parsed).toBeGreaterThanOrEqual(before - 2000);
		expect(parsed).toBeLessThanOrEqual(after + 2000);
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
			makeDraft({ fromAddress: 'Müller <m@x.test>' }),
			[],
			'<id@owlat.test>',
			undefined,
			undefined,
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
