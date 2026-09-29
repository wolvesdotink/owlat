/**
 * Signer-to-verifier round trip over the header splitting rules both sides
 * share (`@owlat/mail-canon` `splitRawHeaderBlock` / `parseRawHeaderFields`).
 *
 * Before they shared one splitter, the signer preferred a CRLFCRLF anywhere in
 * the message over an earlier LFLF, and treated any `\s` (including `\v`) as a
 * fold, while `verifyDkim` took whichever blank line came first and folded on
 * SP/HTAB only. A message where the two rules differ was signed over one set
 * of fields and verified over another, so our own signature failed our own
 * verifier. Each case here is such a message.
 *
 * `@owlat/mail-auth` is a test-only oracle here, as in `dkim.test.ts` (see the
 * note there on why it is not a declared dependency).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { parseRawHeaderFields, splitRawHeaderBlock } from '@owlat/mail-canon';
import { verifyDkim } from '@owlat/mail-auth';
import { composeMessage } from '../src/compose/compose';
import { signMessage, type DkimSigningKey } from '../src/compose/dkim';

interface MailauthParsedHeader {
	key: string | null;
	casedKey?: string;
	line: Buffer;
}
const require = createRequire(import.meta.url);
const tools = require('mailauth/lib/tools.js') as {
	parseHeaders(buf: Buffer): { parsed: MailauthParsedHeader[] };
};

const DOMAIN = 'example.com';
const SELECTOR = 'split2026';
const SIGN_TIME_MS = 1_760_000_000_000;

let signingKey: DkimSigningKey;
let resolver: (name: string, rrtype: string) => Promise<string[][]>;

beforeAll(() => {
	const { publicKey, privateKey } = generateKeyPairSync('rsa', {
		modulusLength: 2048,
		publicKeyEncoding: { type: 'spki', format: 'pem' },
		privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
	});
	signingKey = { domainName: DOMAIN, keySelector: SELECTOR, privateKey };
	const p = publicKey
		.replace('-----BEGIN PUBLIC KEY-----', '')
		.replace('-----END PUBLIC KEY-----', '')
		.replace(/\s/g, '');
	const expectedName = `${SELECTOR}._domainkey.${DOMAIN}`;
	resolver = async (name: string, rrtype: string): Promise<string[][]> =>
		rrtype === 'TXT' && name === expectedName ? [[`v=DKIM1; k=rsa; p=${p}`]] : [];
});

async function roundTrip(raw: string): Promise<string> {
	const signed = signMessage(Buffer.from(raw, 'binary'), signingKey, SIGN_TIME_MS);
	return (await verifyDkim(signed, { resolver })).result;
}

/** The h= tag of the signature the signer prepends. */
function signedHeaderList(raw: string): string[] {
	const signed = signMessage(Buffer.from(raw, 'binary'), signingKey, SIGN_TIME_MS);
	const sigField = parseRawHeaderFields(
		splitRawHeaderBlock(signed.toString('binary')).headerBlock
	)[0];
	const h = /\bh=([^;]+)/.exec(sigField!.raw.replace(/\r\n[ \t]/g, ''))?.[1] ?? '';
	return h.split(':').map((name) => name.trim().toLowerCase());
}

describe('DKIM signer to verifier round trip over line endings', () => {
	it.each([
		[
			'CRLF',
			'From: a@example.com\r\nTo: r@elsewhere.test\r\nSubject: Hello\r\n there\r\n\r\nbody\r\nline two\r\n',
		],
		[
			'LF only',
			'From: a@example.com\nTo: r@elsewhere.test\nSubject: Hello\n\tthere\n\nbody\nline two\n',
		],
		[
			'mixed line endings',
			'From: a@example.com\r\nTo: r@elsewhere.test\nSubject: Hello\r\n there\n\nbody\r\nline two\n',
		],
		[
			'LF-only headers with a CRLF blank line in the body',
			'From: a@example.com\nTo: r@elsewhere.test\nSubject: Hello\n\nfirst paragraph\r\n\r\nX-Not-A-Header: body\r\n',
		],
		[
			'CRLF line then a bare LF blank line',
			'From: a@example.com\r\nTo: r@elsewhere.test\r\nSubject: Hello\r\n\nbody\r\n\r\nmore\r\n',
		],
	])('%s verifies pass', async (_label, raw) => {
		expect(await roundTrip(raw)).toBe('pass');
	});

	it('does not sign body lines as headers when LFLF comes first', () => {
		const raw =
			'From: a@example.com\nSubject: Hello\n\nTo: body-line@elsewhere.test\r\n\r\nbody\r\n';
		const h = signedHeaderList(raw);
		expect(h.filter((name) => name === 'to')).toHaveLength(1); // the oversign slot only
	});
});

describe('a header line starting with \\v', () => {
	const raw =
		'From: a@example.com\r\nTo: r@elsewhere.test\r\nSubject: Hello\r\n\vX-Evil: 1\r\n\r\nbody\r\n';

	it('is its own field on both sides, so the signature verifies', async () => {
		const fields = parseRawHeaderFields(splitRawHeaderBlock(raw).headerBlock);
		expect(fields.map((f) => f.raw)).toContain('Subject: Hello');
		expect(fields.map((f) => f.raw)).toContain('\vX-Evil: 1');
		expect(await roundTrip(raw)).toBe('pass');
	});
});

describe('composer output parses the same as mailauth parseHeaders', () => {
	it('yields byte-identical fields for CRLF messages the composer produces', () => {
		const date = new Date('2026-06-21T12:00:00Z');
		const messages = [
			composeMessage({
				from: 'Grüße <a@example.com>',
				to: ['recipient@elsewhere.test', 'second@elsewhere.test'],
				cc: ['carbon@elsewhere.test'],
				subject: 'Grüße und 日本語 — a long-ish subject to exercise folding of the header value',
				html: '<p>Hello <b>world</b></p>',
				text: 'Hello world',
				date,
				boundarySeed: 'seed',
				messageId: '<split@example.com>',
				headers: {
					'List-Unsubscribe': '<https://example.com/unsub/contact-123:1700000000000:sigabc>',
					'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
				},
			}).raw,
		];
		for (const raw of messages) {
			const ours = parseRawHeaderFields(splitRawHeaderBlock(raw.toString('binary')).headerBlock);
			// mailauth's signer hands parseHeaders the header section only.
			const theirs = tools.parseHeaders(raw.subarray(0, raw.indexOf('\r\n\r\n'))).parsed;
			expect(ours.some((f) => f.raw.includes('\r\n'))).toBe(true); // a folded field is covered
			expect(
				ours.map((f) => ({
					key: f.name,
					casedKey: f.casedName,
					line: Buffer.from(f.raw, 'binary'),
				}))
			).toEqual(theirs.map((h) => ({ key: h.key, casedKey: h.casedKey, line: h.line })));
		}
	});
});
