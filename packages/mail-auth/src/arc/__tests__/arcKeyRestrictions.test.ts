/**
 * ARC-Seal key-record restrictions (RFC 6376 §3.6.1 applied to the seal key).
 *
 * The DKIM verifier already rejects a `_domainkey` record whose explicit `s=`
 * service list does not authorize email, or whose `h=` list forbids the hash in
 * use. The ARC-Seal key fetch consumes the SAME record format and must enforce
 * the SAME restrictions — otherwise a key the DKIM path would reject could still
 * validate an ARC seal (a fail-open inconsistency). ARC-Seal is always *-sha256
 * (RFC 8617 §4.1.3), so an `h=` that omits sha256 makes the key unusable, and an
 * `s=` service list lacking `email`/`*` makes it unusable for email. In both
 * cases the seal is unverifiable, so the chain is `cv: 'fail'`, never `pass`.
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

const KEY_NAME = 'arc1._domainkey.lists.sourceforge.net';

/** Seal a valid 1-hop chain with a fresh 2048-bit key and publish `txtTags`. */
async function oneHopWithKeyRecord(
	tags: string
): Promise<{ message: Buffer; resolver: ArcTestResolver; privateKey: KeyObject }> {
	const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
	const p = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
	const keys: KeyManifest = { [KEY_NAME]: `v=DKIM1; k=rsa; ${tags}p=${p}` };
	const message = await sealHop(BASE_MESSAGE, {
		domain: 'lists.sourceforge.net',
		selector: 'arc1',
		privateKey,
		instance: 1,
		cv: 'none',
		authResults: AAR_PASS,
	});
	return { message, resolver: resolverFor(keys), privateKey };
}

describe('verifyArc — ARC-Seal key-record restrictions', () => {
	it('a seal key whose s= service list omits email/* is unusable -> cv: fail', async () => {
		const { message, resolver } = await oneHopWithKeyRecord('s=other; ');
		const result = await verifyArc(message, { resolver });
		expect(result.cv).toBe('fail');
		expect(result.cv).not.toBe('pass');
	});

	it('a seal key whose h= list forbids sha256 is unusable -> cv: fail', async () => {
		const { message, resolver } = await oneHopWithKeyRecord('h=sha1; ');
		const result = await verifyArc(message, { resolver });
		expect(result.cv).toBe('fail');
		expect(result.cv).not.toBe('pass');
	});

	it('a seal key with s=email (or s=*) and no h= restriction still passes (regression guard)', async () => {
		const emailKey = await oneHopWithKeyRecord('s=email; ');
		expect((await verifyArc(emailKey.message, { resolver: emailKey.resolver })).cv).toBe('pass');
		const starKey = await oneHopWithKeyRecord('s=*; ');
		expect((await verifyArc(starKey.message, { resolver: starKey.resolver })).cv).toBe('pass');
	});
});
