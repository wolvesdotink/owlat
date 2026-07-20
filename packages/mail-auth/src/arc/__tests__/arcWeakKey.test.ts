/**
 * ARC-Seal — RFC 8301 §3.2 minimum RSA key length.
 *
 * A seal signed by an RSA key shorter than 1024 bits MUST NOT be treated as
 * valid — a factorable modulus makes the seal forgeable, so a forwarder could
 * mint a "valid" chain that rescues spoofed mail. Even when the seal verifies
 * cryptographically the chain must be `cv: 'fail'`, never `pass`. mailauth
 * enforces the same `minBitLength: 1024`. This suite seals a real 1-hop chain
 * with a 512-bit key and asserts `cv: 'fail'`; a 2048-bit key is the regression
 * guard that a legitimate chain still passes.
 */

import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, type KeyObject } from 'crypto';
import { verifyArc } from '../verify.js';
import {
	BASE_MESSAGE,
	resolverFor,
	sealHop,
	type ArcTestResolver,
	type KeyManifest,
} from './helpers/seal.js';

const AAR_PASS =
	'lists.sourceforge.net; dmarc=pass header.from=author.example; ' +
	'spf=pass smtp.mailfrom=lists.example; dkim=pass header.d=author.example';

/** Generate an RSA key of `bits` and its `k=rsa` DKIM TXT record. */
function makeRsaKeyOfBits(bits: number): { privateKey: KeyObject; txt: string } {
	const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: bits });
	const der = publicKey.export({ type: 'spki', format: 'der' });
	return { privateKey, txt: `v=DKIM1; k=rsa; p=${der.toString('base64')}` };
}

/** Seal a valid 1-hop chain with an RSA key of the given size. */
async function oneHopWithBits(
	bits: number
): Promise<{ message: Buffer; resolver: ArcTestResolver }> {
	const key = makeRsaKeyOfBits(bits);
	const keys: KeyManifest = { 'arc1._domainkey.lists.sourceforge.net': key.txt };
	const message = await sealHop(BASE_MESSAGE, {
		domain: 'lists.sourceforge.net',
		selector: 'arc1',
		privateKey: key.privateKey,
		instance: 1,
		cv: 'none',
		authResults: AAR_PASS,
	});
	return { message, resolver: resolverFor(keys) };
}

describe('verifyArc — RFC 8301 minimum RSA key length', () => {
	it('a 1-hop chain sealed by a 512-bit RSA key is cv: fail (weak key rejected)', async () => {
		const { message, resolver } = await oneHopWithBits(512);
		const result = await verifyArc(message, { resolver });
		expect(result.cv).toBe('fail');
		expect(result.cv).not.toBe('pass');
	});

	it('a 1-hop chain sealed by a 2048-bit RSA key is cv: pass (regression guard)', async () => {
		const { message, resolver } = await oneHopWithBits(2048);
		const result = await verifyArc(message, { resolver });
		expect(result.cv).toBe('pass');
	});
});
