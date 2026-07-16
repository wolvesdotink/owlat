/**
 * DKIM `l=` body-length policy — the ONE sanctioned semantics change on the
 * inbound path (locked decision D2).
 *
 * `l=` lets a signer sign only the first N bytes of the body, which lets an
 * attacker APPEND arbitrary unsigned content to a validly-signed message. The
 * old `mailauth` path honors `l=` and returns `pass`. We instead CAP any
 * `l=`-bearing signature at `neutral`: the crypto is honored (so a mismatch is
 * still `fail`), but a would-be `pass` becomes `neutral` — we refuse to call an
 * append-vulnerable message authenticated.
 *
 * The signatures here are minted in-test with Node crypto over the package's
 * OWN canonicalization (the public `canon` API), which also demonstrates that
 * "anything our own signer produces verifies" (its pass path is exercised by
 * the control case below).
 */

import { describe, it, expect } from 'vitest';
import { createHash, createSign, generateKeyPairSync } from 'crypto';
import { canonicalizeBodyRelaxed, canonicalizeHeaderField } from '../../canon.js';
import { verifyDkim, type DkimDnsResolver } from '../verify.js';

const DOMAIN = 'example.com';
const SELECTOR = 'sel';
const KEY_NAME = `${SELECTOR}._domainkey.${DOMAIN}`;

const rsa = generateKeyPairSync('rsa', {
	modulusLength: 2048,
	publicKeyEncoding: { type: 'spki', format: 'pem' },
	privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const txtRecord = `v=DKIM1; k=rsa; p=${rsa.publicKey
	.replace(/-----BEGIN PUBLIC KEY-----/, '')
	.replace(/-----END PUBLIC KEY-----/, '')
	.replace(/\s+/g, '')}`;

const resolver: DkimDnsResolver = async (name, rrtype) => {
	if (rrtype === 'TXT' && name === KEY_NAME) {
		return [[txtRecord]];
	}
	throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
};

const SIGNED_HEADERS = [
	'From: Alice <alice@example.com>',
	'To: Bob <bob@example.org>',
	'Subject: l-tag fixture',
];
const H_TAG = 'from:to:subject';

/**
 * Mint a relaxed/relaxed rsa-sha256 signature over `SIGNED_HEADERS` + `body`,
 * optionally with an `l=` tag limiting the signed body length. Returns the raw
 * message (DKIM-Signature header prepended).
 */
function sign(body: string, opts: { readonly l?: number } = {}): Buffer {
	let canonBody = canonicalizeBodyRelaxed(Buffer.from(body, 'latin1'));
	if (opts.l !== undefined) {
		canonBody = canonBody.subarray(0, opts.l);
	}
	const bh = createHash('sha256').update(canonBody).digest('base64');

	const lPart = opts.l !== undefined ? ` l=${opts.l};` : '';
	const sigHeaderUnsigned =
		`DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=${DOMAIN}; s=${SELECTOR};` +
		` h=${H_TAG}; bh=${bh};${lPart} b=`;

	const parts = SIGNED_HEADERS.map((h) => `${canonicalizeHeaderField(h, 'relaxed')}\r\n`);
	const headerInput = Buffer.from(
		parts.join('') + canonicalizeHeaderField(sigHeaderUnsigned, 'relaxed'),
		'latin1'
	);
	const b = createSign('sha256').update(headerInput).sign(rsa.privateKey, 'base64');

	const message = `${SIGNED_HEADERS.join('\r\n')}\r\n\r\n${body}`;
	return Buffer.from(`${sigHeaderUnsigned}${b}\r\n${message}`, 'latin1');
}

describe('DKIM l= body-length policy (D2 sanctioned improvement)', () => {
	it('control: a full-body signature WITHOUT l= verifies pass', async () => {
		const body = 'Fully signed body.\r\n';
		const outcome = await verifyDkim(sign(body), { resolver });
		expect(outcome.result).toBe('pass');
		expect(outcome.domain).toBe(DOMAIN);
	});

	it('a signature carrying l= over the whole body is CAPPED at neutral', async () => {
		const body = 'Fully signed body.\r\n';
		const canonLen = canonicalizeBodyRelaxed(Buffer.from(body, 'latin1')).length;
		const outcome = await verifyDkim(sign(body, { l: canonLen }), { resolver });
		expect(outcome.result).toBe('neutral');
	});

	it('APPEND ATTACK: unsigned bytes appended past l= -> neutral, never pass', async () => {
		const signedPortion = 'Signed portion.\r\n';
		const signedLen = canonicalizeBodyRelaxed(Buffer.from(signedPortion, 'latin1')).length;
		// Sign only the prefix, then append attacker-controlled content.
		const fullBody = `${signedPortion}CLICK http://evil.example/ NOW\r\n`;
		const signed = sign(fullBody, { l: signedLen });

		const outcome = await verifyDkim(signed, { resolver });
		// The crypto is valid over the signed prefix — old library would pass —
		// but the l= cap refuses to authenticate the appended tail.
		expect(outcome.result).toBe('neutral');
		expect(outcome.result).not.toBe('pass');
	});

	it('l= present but the signed prefix was tampered -> fail (not neutral)', async () => {
		const body = 'Original signed line.\r\n';
		const canonLen = canonicalizeBodyRelaxed(Buffer.from(body, 'latin1')).length;
		const signed = sign(body, { l: canonLen }).toString('latin1');
		// Corrupt a byte inside the signed prefix so the body hash mismatches.
		const tampered = signed.replace('Original', 'Modified');
		const outcome = await verifyDkim(Buffer.from(tampered, 'latin1'), { resolver });
		expect(outcome.result).toBe('fail');
	});
});
