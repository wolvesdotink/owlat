/**
 * DKIM — RFC 8301 §3.2 minimum RSA key length.
 *
 * A verifier MUST NOT treat an RSA public key shorter than 1024 bits as valid:
 * a sub-1024-bit modulus is factorable, so a "cryptographically valid"
 * signature from such a key is trivially forgeable. Even when the signature
 * verifies against the published key, the verdict must be a policy failure
 * (`fail`) — never `pass`. mailauth (the differential oracle) enforces the same
 * `minBitLength: 1024`. This suite generates a real 512-bit key, signs a
 * message with it, and asserts we do NOT return `pass`; a 2048-bit key is the
 * regression guard that legitimate keys still pass.
 */

import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { verifyDkim } from '../verify.js';
import { mintSignature } from './helpers/mint.js';

type DnsFn = (name: string, rrtype: 'TXT') => Promise<string[][]>;

const DOMAIN = 'weak.example';
const SELECTOR = 'sel';
const KEY_NAME = `${SELECTOR}._domainkey.${DOMAIN}`;

const HEADERS = [
	'From: Mallory <mallory@weak.example>',
	'To: Victim <victim@example.org>',
	'Subject: forged with a weak key',
];
const BODY = 'Body signed by a factorable RSA key.\r\n';

/** SPKI DER (base64) of a public key — the DKIM `p=` payload. */
function spkiBase64(publicKey: import('crypto').KeyObject): string {
	return publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
}

function resolverFor(record: string): DnsFn {
	return async (name, rrtype) => {
		if (rrtype === 'TXT' && name === KEY_NAME) {
			return [[record]];
		}
		const err = new Error(`ENOTFOUND ${name}`) as Error & { code: string };
		err.code = 'ENOTFOUND';
		throw err;
	};
}

function signWith(bits: number): { message: Buffer; resolver: DnsFn } {
	const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: bits });
	const message = mintSignature({
		privateKey,
		domain: DOMAIN,
		selector: SELECTOR,
		headers: HEADERS,
		hTag: 'from:to:subject',
		body: BODY,
	});
	return { message, resolver: resolverFor(`v=DKIM1; k=rsa; p=${spkiBase64(publicKey)}`) };
}

describe('verifyDkim — RFC 8301 minimum RSA key length', () => {
	it('a cryptographically valid signature from a 512-bit RSA key is NOT pass (weak-key policy fail)', async () => {
		const { message, resolver } = signWith(512);
		const result = await verifyDkim(message, { resolver });
		expect(result.result).not.toBe('pass');
		expect(result.result).toBe('fail');
	});

	it('a 2048-bit RSA key still passes (regression guard)', async () => {
		const { message, resolver } = signWith(2048);
		const result = await verifyDkim(message, { resolver });
		expect(result.result).toBe('pass');
	});
});
