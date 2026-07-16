/**
 * DKIM `signMessage` — the in-house outbound signer, built on the shared
 * `@owlat/mail-auth/canon` canonicalizer (unification decision U4, merged pieces
 * old wire-M3 + inbound-A3).
 *
 * The unified repo lets us assert a THREE-WAY agreement no single-direction
 * pipeline could:
 *
 *   (a) THREE-WAY VERIFY — every signature our signer produces verifies both
 *       under `mailauth` (the independent oracle, kept as a devDependency) AND
 *       under our own `verifyDkim` from `@owlat/mail-auth`. Signer and both
 *       verifiers agree because all three canonicalize through the ONE canon.
 *
 *   (b) BIT-FOR-BIT vs the current signer — for a corpus of messages, the header
 *       our canon-based signer emits is byte-identical to the one the MTA's
 *       `mailauth`-internals-based signer (`apps/mta/src/smtp/dkim.ts`) emits.
 *       The reference below reproduces that signer's exact algorithm using
 *       `mailauth`'s own `parseHeaders` / `formatRelaxedLine` /
 *       `formatSignatureHeaderLine` / `dkimBody` — so a byte match proves our
 *       ports of those (canon + our own assembly) match mailauth's, including
 *       oversigning From/Subject/To and the `t=` timestamp.
 *
 *   (c) FOLD-STABLE round-trip — a composed → signed message parses cleanly with
 *       `mailparser` and its folded `DKIM-Signature` still verifies, proving the
 *       75/76-octet folding survives a real parser.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { simpleParser } from 'mailparser';
import { dkimVerify } from 'mailauth';
import { verifyDkim } from '@owlat/mail-auth';
import { composeMessage } from '../src/compose/compose';
import { signMessage, buildDkimSignatureLine, type DkimSigningKey } from '../src/compose/dkim';

/* -------------------------------------------------------------------------- */
/*  mailauth internals — the oracle for the bit-for-bit reference signer.      */
/*  Loaded via createRequire so the untyped CJS internals never need an        */
/*  ambient declaration in this pure package (they exist only for this test).  */
/* -------------------------------------------------------------------------- */

interface MailauthParsedHeader {
	key: string | null;
	casedKey?: string;
	line: Buffer;
}
interface MailauthTools {
	parseHeaders(buf: Buffer): { parsed: MailauthParsedHeader[]; original: Buffer };
	formatRelaxedLine(line: Buffer | string, suffix?: string): Buffer;
	formatSignatureHeaderLine(
		type: string,
		values: Record<string, string | number>,
		folded?: boolean
	): Buffer | string;
	getPrivateKey(key: string | Buffer): import('node:crypto').KeyObject;
}
interface DkimBodyHasher {
	update(chunk: Buffer): void;
	digest(encoding: string): string;
}
interface DkimBodyModule {
	dkimBody(canon: string, algorithm?: string, maxBodyLength?: number | false): DkimBodyHasher;
}

const require = createRequire(import.meta.url);
const tools = require('mailauth/lib/tools.js') as MailauthTools;
const { dkimBody } = require('mailauth/lib/dkim/body/index.js') as DkimBodyModule;

/** The signed / oversigned header contract — identical to the MTA signer. */
const SIGNED_HEADERS = [
	'from',
	'sender',
	'reply-to',
	'subject',
	'date',
	'message-id',
	'to',
	'cc',
	'mime-version',
	'content-type',
	'content-transfer-encoding',
	'list-unsubscribe',
	'list-unsubscribe-post',
];
const OVERSIGNED_HEADERS = ['from', 'subject', 'to'];

function splitHeadersAndBody(raw: Buffer): { headerBuf: Buffer; bodyBuf: Buffer } {
	let idx = raw.indexOf('\r\n\r\n');
	let sepLen = 4;
	if (idx === -1) {
		idx = raw.indexOf('\n\n');
		sepLen = 2;
	}
	if (idx === -1) return { headerBuf: raw, bodyBuf: Buffer.alloc(0) };
	return { headerBuf: raw.subarray(0, idx), bodyBuf: raw.subarray(idx + sepLen) };
}

/**
 * Byte-for-byte reproduction of `apps/mta/src/smtp/dkim.ts` `signMessage`, using
 * mailauth's own internals. This is the "current signer" the ported one must
 * match exactly.
 */
function referenceSign(raw: Buffer, key: DkimSigningKey, signTimeMs: number): string {
	const { headerBuf, bodyBuf } = splitHeadersAndBody(raw);

	const hasher = dkimBody('relaxed', 'sha256', false);
	hasher.update(bodyBuf);
	const bodyHash = hasher.digest('base64');

	const { parsed } = tools.parseHeaders(headerBuf);

	const byName = new Map<string, MailauthParsedHeader[]>();
	for (let i = parsed.length - 1; i >= 0; i--) {
		const h = parsed[i];
		if (!h || h.key == null) continue;
		const arr = byName.get(h.key);
		if (arr) arr.push(h);
		else byName.set(h.key, [h]);
	}

	const consumed = new Map<string, number>();
	const takeNext = (name: string): MailauthParsedHeader | undefined => {
		const arr = byName.get(name);
		const used = consumed.get(name) ?? 0;
		consumed.set(name, used + 1);
		return arr ? arr[used] : undefined;
	};

	const hKeys: string[] = [];
	const canonChunks: Buffer[] = [];

	for (const name of SIGNED_HEADERS) {
		if (!byName.has(name)) continue;
		const inst = takeNext(name);
		if (!inst) continue;
		hKeys.push(inst.casedKey ?? name);
		canonChunks.push(tools.formatRelaxedLine(inst.line, '\r\n'));
	}
	for (const name of OVERSIGNED_HEADERS) {
		const inst = takeNext(name);
		hKeys.push(name);
		if (inst) canonChunks.push(tools.formatRelaxedLine(inst.line, '\r\n'));
	}

	const tags: Record<string, string | number> = {
		a: 'rsa-sha256',
		c: 'relaxed/relaxed',
		s: key.keySelector,
		d: key.domainName,
		h: hKeys.join(':'),
		bh: bodyHash,
		t: Math.floor(signTimeMs / 1000),
	};

	const placeholderLine = tools
		.formatSignatureHeaderLine('DKIM', { b: 'a'.repeat(73), ...tags }, true)
		.toString();
	const dkimCanon = tools
		.formatRelaxedLine(placeholderLine)
		.toString('binary')
		.replace(/([;:\s]+b=)[^;]+/, '$1');
	canonChunks.push(Buffer.from(dkimCanon, 'binary'));

	const signature = createSign('RSA-SHA256')
		.update(Buffer.concat(canonChunks))
		.sign(tools.getPrivateKey(key.privateKey), 'base64');

	return tools.formatSignatureHeaderLine('DKIM', { b: signature, ...tags }, true).toString();
}

/* -------------------------------------------------------------------------- */
/*  Keys, DNS resolver, corpus.                                               */
/* -------------------------------------------------------------------------- */

const DOMAIN = 'example.com';
const SELECTOR = 's2026';
const SIGN_TIME_MS = 1_760_000_000_000; // fixed so t= is deterministic

let signingKey: DkimSigningKey;
let resolver: (name: string, rrtype: 'TXT') => Promise<string[][]>;

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
	const record = `v=DKIM1; k=rsa; p=${p}`;
	const expectedName = `${SELECTOR}._domainkey.${DOMAIN}`;
	resolver = async (name: string, rrtype: 'TXT'): Promise<string[][]> =>
		rrtype === 'TXT' && name === expectedName ? [[record]] : [];
});

/** Corpus of composed messages covering the real shapes outbound mail takes. */
function corpus(): Array<{ name: string; raw: Buffer }> {
	const date = new Date('2026-06-21T12:00:00Z');
	const boundarySeed = 'fixed-seed-for-determinism';
	const composed: Array<{ name: string; raw: Buffer }> = [
		{
			name: 'plain text',
			raw: composeMessage({
				from: 'a@example.com',
				to: ['recipient@elsewhere.test'],
				subject: 'Hello from the signer',
				text: 'This is the signed body.\nSecond line.\n',
				date,
				boundarySeed,
				messageId: '<plain@example.com>',
			}).raw,
		},
		{
			name: 'html + text multipart',
			raw: composeMessage({
				from: 'Owlat <a@example.com>',
				to: ['recipient@elsewhere.test', 'second@elsewhere.test'],
				cc: ['carbon@elsewhere.test'],
				subject: 'Multipart digest',
				html: '<p>Hello <b>world</b></p>',
				text: 'Hello world',
				date,
				boundarySeed,
				messageId: '<multi@example.com>',
			}).raw,
		},
		{
			name: 'one-click unsubscribe pair',
			raw: composeMessage({
				from: 'a@example.com',
				to: ['recipient@elsewhere.test'],
				subject: 'Weekly digest',
				text: 'Newsletter body.\n',
				date,
				boundarySeed,
				messageId: '<oneclick@example.com>',
				headers: {
					'List-Unsubscribe': '<https://example.com/unsub/contact-123:1700000000000:sigabc>',
					'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
				},
			}).raw,
		},
		{
			name: 'unicode subject + display name',
			raw: composeMessage({
				from: 'Grüße <a@example.com>',
				to: ['recipient@elsewhere.test'],
				subject: 'Grüße und 日本語 — a long-ish subject to exercise folding of the header value',
				text: 'Körper.\n',
				date,
				boundarySeed,
				messageId: '<unicode@example.com>',
			}).raw,
		},
	];

	// A hand-built raw message with an empty body (relaxed empty-body edge).
	composed.push({
		name: 'raw empty body',
		raw: Buffer.from(
			'From: a@example.com\r\nTo: recipient@elsewhere.test\r\nSubject: Empty\r\n\r\n',
			'utf8'
		),
	});

	return composed;
}

/* -------------------------------------------------------------------------- */
/*  (b) BIT-FOR-BIT vs the current (mailauth-based) signer.                   */
/* -------------------------------------------------------------------------- */

describe('signMessage — bit-for-bit vs the current MTA signer (old wire-M3)', () => {
	it('emits an identical DKIM-Signature header for every corpus message', () => {
		for (const { name, raw } of corpus()) {
			const ours = buildDkimSignatureLine(raw, signingKey, SIGN_TIME_MS);
			const reference = referenceSign(raw, signingKey, SIGN_TIME_MS);
			expect(ours, `mismatch for "${name}"`).toBe(reference);
		}
	});

	it('oversigns From/Subject/To (each listed >= 2 times) and stamps t=', () => {
		const { raw } = corpus()[0]!;
		const sig = buildDkimSignatureLine(raw, signingKey, SIGN_TIME_MS).replace(/\r\n[ \t]+/g, ' ');
		const hMatch = /(?:^|;|\s)h=([^;]+)/.exec(sig);
		expect(hMatch).not.toBeNull();
		const list = hMatch![1]!.split(':').map((h) => h.trim().toLowerCase());
		expect(list.filter((h) => h === 'from').length).toBeGreaterThanOrEqual(2);
		expect(list.filter((h) => h === 'subject').length).toBeGreaterThanOrEqual(2);
		expect(list.filter((h) => h === 'to').length).toBeGreaterThanOrEqual(2);
		expect(sig).toMatch(new RegExp(`(?:^|;|\\s)t=${Math.floor(SIGN_TIME_MS / 1000)}(?:;|\\s|$)`));
		// No l= (appendix-attack) tag, never rsa-sha1 (RFC 8301).
		expect(sig).not.toMatch(/(^|;)\s*l=/);
		expect(sig).not.toMatch(/rsa-sha1/i);
	});

	it('the ported body hash equals mailauth relaxed dkimBody', () => {
		for (const { raw } of corpus()) {
			const { bodyBuf } = splitHeadersAndBody(raw);
			const hasher = dkimBody('relaxed', 'sha256', false);
			hasher.update(bodyBuf);
			const oracle = hasher.digest('base64');
			// Reproduce the ported signer's body-hash path (canon + sha256) via the
			// emitted bh= tag — it must equal the oracle.
			const sig = buildDkimSignatureLine(raw, signingKey, SIGN_TIME_MS).replace(/\r\n[ \t]+/g, '');
			const bh = /(?:^|;|\s)bh=([^;]+)/.exec(sig)?.[1];
			expect(bh).toBe(oracle);
		}
	});
});

/* -------------------------------------------------------------------------- */
/*  (a) THREE-WAY VERIFY — mailauth AND our own verifyDkim.                   */
/* -------------------------------------------------------------------------- */

interface MailauthVerifyResult {
	results: Array<{ status: { result: string }; signingDomain?: string; selector?: string }>;
}

describe('signMessage — three-way agreement (verifies under mailauth AND our verifyDkim)', () => {
	it('every corpus signature verifies pass under both verifiers', async () => {
		for (const { name, raw } of corpus()) {
			const signed = signMessage(raw, signingKey, SIGN_TIME_MS);

			// The signature is PREPENDED, not corrupting the original bytes.
			expect(signed.subarray(signed.length - raw.length)).toEqual(raw);
			expect(signed.toString('utf8')).toMatch(/^DKIM-Signature:/);

			const oracle = (await dkimVerify(signed.toString('binary'), {
				resolver,
			})) as unknown as MailauthVerifyResult;
			expect(oracle.results.length, `mailauth for "${name}"`).toBeGreaterThan(0);
			expect(oracle.results[0]!.status.result, `mailauth for "${name}"`).toBe('pass');
			expect(oracle.results[0]!.signingDomain).toBe(DOMAIN);

			const ours = await verifyDkim(signed, { resolver });
			expect(ours.result, `verifyDkim for "${name}"`).toBe('pass');
			expect(ours.domain).toBe(DOMAIN);
		}
	});

	it('tampering the signed body fails both verifiers', async () => {
		const raw = Buffer.from(
			'From: a@example.com\r\nTo: r@elsewhere.test\r\nSubject: Integrity\r\n\r\noriginal body content\r\n',
			'utf8'
		);
		const signed = signMessage(raw, signingKey, SIGN_TIME_MS);
		const tampered = Buffer.from(
			signed.toString('binary').replace('original body content', 'modified body content'),
			'binary'
		);

		const oracle = (await dkimVerify(tampered.toString('binary'), {
			resolver,
		})) as unknown as MailauthVerifyResult;
		expect(oracle.results[0]!.status.result).not.toBe('pass');

		const ours = await verifyDkim(tampered, { resolver });
		expect(ours.result).not.toBe('pass');
	});

	it('a From injected AFTER signing breaks both verifiers (oversigning)', async () => {
		const raw = Buffer.from(
			'From: a@example.com\r\nTo: r@elsewhere.test\r\nSubject: Original\r\n\r\nlegit body\r\n',
			'utf8'
		);
		const signed = signMessage(raw, signingKey, SIGN_TIME_MS);
		const injected = Buffer.concat([Buffer.from('From: attacker@evil.test\r\n', 'utf8'), signed]);

		const oracle = (await dkimVerify(injected.toString('binary'), {
			resolver,
		})) as unknown as MailauthVerifyResult;
		expect(oracle.results[0]!.status.result).not.toBe('pass');

		const ours = await verifyDkim(injected, { resolver });
		expect(ours.result).not.toBe('pass');
	});
});

/* -------------------------------------------------------------------------- */
/*  (c) FOLD-STABLE — compose -> sign -> parse (mailparser) -> re-verify.     */
/* -------------------------------------------------------------------------- */

describe('signMessage — fold-stable through mailparser', () => {
	it('a signed message parses cleanly and its folded signature still verifies', async () => {
		const { raw } = composeMessage({
			from: 'a@example.com',
			to: ['recipient@elsewhere.test', 'second@elsewhere.test', 'third@elsewhere.test'],
			subject: 'Fold stability across a real parser',
			html: '<p>A body long enough that the base64 signature value folds onto continuation lines.</p>',
			text: 'A body long enough that the base64 signature value folds onto continuation lines.',
			date: new Date('2026-06-21T12:00:00Z'),
			boundarySeed: 'fold-seed',
			messageId: '<fold@example.com>',
		});
		const signed = signMessage(raw, signingKey, SIGN_TIME_MS);
		const text = signed.toString('utf8');

		// The DKIM-Signature is multi-line (folded) — a continuation line starts
		// with folding white space.
		const sigBlock = /^DKIM-Signature:[\s\S]*?\r\n(?![ \t])/m.exec(text);
		expect(sigBlock).not.toBeNull();
		expect(sigBlock![0]).toMatch(/\r\n[ \t]/);

		// mailparser accepts it as well-formed RFC822 and surfaces the header.
		const parsed = await simpleParser(signed);
		expect(parsed.headers.has('dkim-signature')).toBe(true);
		expect(parsed.subject).toBe('Fold stability across a real parser');

		// The folded signature survives end-to-end: it still verifies pass.
		const ours = await verifyDkim(signed, { resolver });
		expect(ours.result).toBe('pass');
		const oracle = (await dkimVerify(text, { resolver })) as unknown as MailauthVerifyResult;
		expect(oracle.results[0]!.status.result).toBe('pass');
	});
});

/* -------------------------------------------------------------------------- */
/*  Determinism: same inputs -> byte-identical signature (DKIM-stable retries) */
/* -------------------------------------------------------------------------- */

describe('signMessage — deterministic given a fixed sign time', () => {
	it('produces byte-identical bytes across repeated signings (RSA PKCS1 is deterministic)', () => {
		const { raw } = corpus()[0]!;
		const a = signMessage(raw, signingKey, SIGN_TIME_MS);
		const b = signMessage(raw, signingKey, SIGN_TIME_MS);
		expect(a.equals(b)).toBe(true);
	});
});
