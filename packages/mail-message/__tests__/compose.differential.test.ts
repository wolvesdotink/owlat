/**
 * The differential harness — the heart of piece M2.
 *
 * For every case in the ~40-input corpus we compose the SAME message twice: once
 * with our pure `composeMessage`, once with nodemailer's `MailComposer` (the
 * library we are replacing). We parse both wire results with mailparser — the
 * independent oracle — and assert SEMANTIC equality: same effective header
 * values, same decoded text/html bodies, same attachment set, same multipart
 * part tree (ordering + nesting), and the same decoded AMP part. Byte equality is
 * NOT required; parsed equality is (locked decision D2 keeps encoding 7-bit safe
 * on both sides, but boundary strings and CTE choices may legitimately differ).
 *
 * Because we compare mailparser(ours) against mailparser(nodemailer), any
 * deterministic normalization mailparser applies cancels out — only a genuine
 * semantic divergence between the two composers can fail an assertion.
 */

import { describe, it, expect } from 'vitest';
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';
import MailComposer from 'nodemailer/lib/mail-composer';
import type Mail from 'nodemailer/lib/mailer';
import { composeMessage } from '../src/index';
import { parseMime } from './mimeWalk';
import { CORPUS, toComposeInput, toNodemailerOptions, type CorpusCase } from './fixtures/corpus';

/** Build the raw RFC822 bytes nodemailer's MailComposer would ship. */
function buildWithNodemailer(options: Mail.Options): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		new MailComposer(options).compile().build((err, message) => {
			if (err) reject(err);
			else resolve(message);
		});
	});
}

/** Normalize a decoded body: CRLF -> LF, drop per-line and trailing whitespace noise. */
function normBody(s: string | undefined): string {
	return (s ?? '')
		.replace(/\r\n/g, '\n')
		.replace(/[ \t]+$/gm, '')
		.replace(/\n+$/, '');
}

/** Flatten an address header to a comparable `{name, address}` list. */
function addrList(
	a: AddressObject | AddressObject[] | undefined
): Array<{ name: string; address: string }> {
	if (a === undefined) return [];
	const objs = Array.isArray(a) ? a : [a];
	const out: Array<{ name: string; address: string }> = [];
	for (const obj of objs) {
		for (const v of obj.value) {
			out.push({ name: v.name ?? '', address: (v.address ?? '').toLowerCase() });
		}
	}
	return out;
}

function refsList(refs: string | string[] | undefined): string[] {
	if (refs === undefined) return [];
	return Array.isArray(refs) ? refs : refs.split(/\s+/).filter((r) => r.length > 0);
}

/**
 * Decode any RFC 2047 encoded-words in a header value to the effective string a
 * reader would see. mailparser does NOT decode unknown `X-*` headers, so a
 * non-ASCII custom value arrives as raw encoded-words — and nodemailer's Q/B
 * selection heuristic differs from ours (`=?UTF-8?Q?Gr=C3=BC=C3=9Fe?=` vs
 * `=?UTF-8?B?...?=`). The card requires equality on EFFECTIVE (decoded) values,
 * not on encoded-word cosmetics, so we decode BOTH sides here (choice (ii) from
 * the review) rather than pinning one composer's Q/B heuristic on the wire.
 */
function decodeEncodedWords(value: string): string {
	// Adjacent encoded-words separated only by folding white space concatenate
	// with the whitespace dropped (RFC 2047 §6.2).
	const collapsed = value.replace(/\?=[ \t\r\n]+=\?/g, '?==?');
	return collapsed.replace(
		/=\?[^?]+\?([BbQq])\?([^?]*)\?=/g,
		(_full, enc: string, payload: string) => {
			if (enc.toUpperCase() === 'B') return Buffer.from(payload, 'base64').toString('utf-8');
			// Q-encoding: `_` -> space, `=XX` -> byte.
			const bytes: number[] = [];
			for (let i = 0; i < payload.length; i++) {
				const c = payload[i]!;
				if (c === '_') bytes.push(0x20);
				else if (c === '=') {
					bytes.push(Number.parseInt(payload.slice(i + 1, i + 3), 16));
					i += 2;
				} else bytes.push(c.charCodeAt(0));
			}
			return Buffer.from(bytes).toString('utf-8');
		}
	);
}

/** Custom `X-…` headers, the effective (RFC-2047-decoded) values a downstream reader would see. */
function customHeaders(mail: ParsedMail): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of mail.headers) {
		if (key.startsWith('x-')) {
			out[key] = decodeEncodedWords(typeof value === 'string' ? value : String(value));
		}
	}
	return out;
}

function attachmentSet(mail: ParsedMail): Array<Record<string, unknown>> {
	return mail.attachments
		.map((a) => ({
			filename: a.filename ?? '',
			contentType: a.contentType,
			related: a.related ?? false,
			cid: a.cid ?? '',
			content: a.content.toString('base64'),
		}))
		.sort((x, y) => `${x.filename}|${x.cid}`.localeCompare(`${y.filename}|${y.cid}`));
}

/** The semantic projection two messages must match on. */
function project(mail: ParsedMail) {
	return {
		subject: mail.subject ?? '',
		date: mail.date?.toISOString() ?? '',
		from: addrList(mail.from),
		to: addrList(mail.to),
		cc: addrList(mail.cc),
		replyTo: addrList(mail.replyTo),
		messageId: mail.messageId ?? '',
		inReplyTo: mail.inReplyTo ?? '',
		references: refsList(mail.references),
		text: normBody(mail.text),
		html: normBody(typeof mail.html === 'string' ? mail.html : ''),
		attachments: attachmentSet(mail),
		custom: customHeaders(mail),
	};
}

/** Decoded `text/x-amp-html` leaf body, or '' when there is no AMP part. */
function ampBody(raw: Buffer): string {
	const leaf = parseMime(raw).leaves.find((l) => l.contentType === 'text/x-amp-html');
	return normBody(leaf?.text);
}

describe('composeMessage differential parity vs nodemailer MailComposer', () => {
	for (const testCase of CORPUS) {
		it(`matches nodemailer semantically: ${testCase.name}`, async () => {
			const ours = composeMessage(toComposeInput(testCase)).raw;
			const theirs = await buildWithNodemailer(toNodemailerOptions(testCase));

			const parsedOurs = await simpleParser(ours);
			const parsedTheirs = await simpleParser(theirs);

			// Same effective headers, decoded bodies, and attachment set.
			expect(project(parsedOurs)).toEqual(project(parsedTheirs));

			// Same multipart part tree (ordering + nesting), including the
			// plain -> amp -> html alternative order.
			expect(parseMime(ours).tree).toEqual(parseMime(theirs).tree);

			// Same decoded AMP body (mailparser flattens the alternative, so this is
			// compared structurally).
			expect(ampBody(ours)).toEqual(ampBody(theirs));
		});
	}

	it('covers a corpus of at least 40 structured inputs', () => {
		expect(CORPUS.length).toBeGreaterThanOrEqual(40);
		// Every case names itself uniquely (reviewable corpus).
		const names = new Set(CORPUS.map((c: CorpusCase) => c.name));
		expect(names.size).toBe(CORPUS.length);
	});
});
