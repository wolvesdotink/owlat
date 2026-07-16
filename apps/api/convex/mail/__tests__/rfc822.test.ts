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
import { buildRfc822, buildMessageId, type DraftRow } from '../rfc822';

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
			undefined
		);
		const eml = raw.toString('utf-8');

		// Anchored at the very start of the message: `Message-ID` is the first
		// header line, the value is `<local.hex@domain>`, terminated by CRLF.
		expect(eml).toMatch(/^Message-ID: <[0-9a-z]+\.[0-9a-f]{12}@acme\.test>\r\n/);

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
			undefined
		);
		const headers = headerBlock(raw);

		// To is present and carries the visible recipient.
		expect(headers).toMatch(/^To: a@x\.test\r?$/m);

		// No Bcc header, and the bcc address never appears anywhere in the
		// header block — it rides the transport envelope only.
		expect(headers).not.toMatch(/^Bcc:/im);
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
		expect(Math.max(...html.split('\n').map((l) => Buffer.byteLength(l, 'utf-8')))).toBeGreaterThan(
			998
		);

		const { raw } = buildRfc822(
			makeDraft({ bodyHtml: html, bodyText: undefined }),
			[],
			'<id@owlat.test>',
			undefined,
			undefined
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
			undefined
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
			undefined
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
			undefined
		);
		const eml = raw.toString('utf-8');
		expect(eml).toContain('Content-Transfer-Encoding: 7bit');
		expect(eml).toContain('<p>Hello world</p>');
		expect(eml).not.toContain('Content-Transfer-Encoding: 8bit');
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
			undefined
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
		const { raw } = buildRfc822(makeDraft(), [], '<id@owlat.test>', undefined, undefined);
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
