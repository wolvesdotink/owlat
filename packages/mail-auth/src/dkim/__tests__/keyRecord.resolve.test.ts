/**
 * `resolveDkimKey` — the one `_domainkey` key resolver shared by the DKIM
 * verifier and the ARC-Seal verifier. One case per failure reason, plus the
 * success paths, so a key-policy change lands in one place and is pinned here.
 */

import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, type KeyObject } from 'crypto';
import { resolveDkimKey, type DkimDnsResolver } from '../keyRecord.js';

const SELECTOR = 'sel';
const DOMAIN = 'example.com';
const KEY_NAME = `${SELECTOR}._domainkey.${DOMAIN}`;
const RSA_SHA256 = { keyType: 'rsa', hash: 'sha256' } as const;

function spki(publicKey: KeyObject): string {
	return publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
}

const rsa2048 = spki(generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey);
const rsa512 = spki(generateKeyPairSync('rsa', { modulusLength: 512 }).publicKey);
// Ed25519 DKIM keys are the raw 32 bytes (RFC 8463): drop the 12-byte SPKI header.
const ed25519Raw = generateKeyPairSync('ed25519')
	.publicKey.export({ type: 'spki', format: 'der' })
	.subarray(12)
	.toString('base64');

/** A resolver answering only `KEY_NAME`, with each record given as its TXT chunks. */
function answering(...records: string[][]): DkimDnsResolver {
	return async (name) => {
		if (name !== KEY_NAME) {
			throw Object.assign(new Error('unexpected name'), { code: 'ENOTFOUND' });
		}
		return records;
	};
}

function rejecting(code: string): DkimDnsResolver {
	return async () => {
		throw Object.assign(new Error(code), { code });
	};
}

describe('resolveDkimKey', () => {
	it('returns the key and record for a usable RSA key', async () => {
		const result = await resolveDkimKey(
			answering([`v=DKIM1; k=rsa; p=${rsa2048}`]),
			SELECTOR,
			DOMAIN,
			RSA_SHA256
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.key.asymmetricKeyType).toBe('rsa');
		expect(result.record.keyType).toBe('rsa');
	});

	it('returns an Ed25519 key built from the raw 32 bytes', async () => {
		const result = await resolveDkimKey(
			answering([`v=DKIM1; k=ed25519; p=${ed25519Raw}`]),
			SELECTOR,
			DOMAIN,
			{ keyType: 'ed25519', hash: 'sha256' }
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.key.asymmetricKeyType).toBe('ed25519');
	});

	it('joins multi-chunk TXT records before parsing', async () => {
		const half = Math.floor(rsa2048.length / 2);
		const result = await resolveDkimKey(
			answering([`v=DKIM1; k=rsa; p=${rsa2048.slice(0, half)}`, rsa2048.slice(half)]),
			SELECTOR,
			DOMAIN,
			RSA_SHA256
		);
		expect(result.ok).toBe(true);
	});

	it('uses the first parseable record when an earlier one is garbage', async () => {
		const result = await resolveDkimKey(
			answering(['v=DKIM9; p=abc'], [`v=DKIM1; p=${rsa2048}`]),
			SELECTOR,
			DOMAIN,
			RSA_SHA256
		);
		expect(result.ok).toBe(true);
	});

	it('no-record: no TXT answer, or only empty strings', async () => {
		expect(await resolveDkimKey(answering(), SELECTOR, DOMAIN, RSA_SHA256)).toEqual({
			ok: false,
			reason: 'no-record',
		});
		expect(await resolveDkimKey(answering([''], ['', '']), SELECTOR, DOMAIN, RSA_SHA256)).toEqual({
			ok: false,
			reason: 'no-record',
		});
	});

	it.each(['ENOTFOUND', 'ENODATA', 'NXDOMAIN', 'NOTFOUND'])(
		'dns-perm: a %s rejection means no such record',
		async (code) => {
			expect(await resolveDkimKey(rejecting(code), SELECTOR, DOMAIN, RSA_SHA256)).toEqual({
				ok: false,
				reason: 'dns-perm',
			});
		}
	);

	it.each(['ESERVFAIL', 'ETIMEOUT', 'ECONNREFUSED'])(
		'dns-temp: a %s rejection is transient',
		async (code) => {
			expect(await resolveDkimKey(rejecting(code), SELECTOR, DOMAIN, RSA_SHA256)).toEqual({
				ok: false,
				reason: 'dns-temp',
			});
		}
	);

	it('dns-temp: a resolver that throws synchronously never escapes', async () => {
		const resolver: DkimDnsResolver = () => {
			throw new Error('boom');
		};
		expect(await resolveDkimKey(resolver, SELECTOR, DOMAIN, RSA_SHA256)).toEqual({
			ok: false,
			reason: 'dns-temp',
		});
	});

	it('unparseable: no record is a usable key record', async () => {
		expect(
			await resolveDkimKey(
				answering(['v=DKIM2; p=abc'], ['k=rsa; no-key-here']),
				SELECTOR,
				DOMAIN,
				RSA_SHA256
			)
		).toEqual({ ok: false, reason: 'unparseable' });
	});

	it('revoked: an empty p=', async () => {
		expect(
			await resolveDkimKey(answering(['v=DKIM1; k=rsa; p=']), SELECTOR, DOMAIN, RSA_SHA256)
		).toEqual({ ok: false, reason: 'revoked' });
	});

	it('key-type-mismatch: an Ed25519 record for an RSA signature and the reverse', async () => {
		expect(
			await resolveDkimKey(
				answering([`v=DKIM1; k=ed25519; p=${ed25519Raw}`]),
				SELECTOR,
				DOMAIN,
				RSA_SHA256
			)
		).toEqual({ ok: false, reason: 'key-type-mismatch' });
		expect(
			await resolveDkimKey(answering([`v=DKIM1; p=${rsa2048}`]), SELECTOR, DOMAIN, {
				keyType: 'ed25519',
				hash: 'sha256',
			})
		).toEqual({ ok: false, reason: 'key-type-mismatch' });
	});

	it('hash-forbidden: an h= list that omits the signature hash', async () => {
		const resolver = answering([`v=DKIM1; k=rsa; h=sha1; p=${rsa2048}`]);
		expect(await resolveDkimKey(resolver, SELECTOR, DOMAIN, RSA_SHA256)).toEqual({
			ok: false,
			reason: 'hash-forbidden',
		});
		const allowed = await resolveDkimKey(resolver, SELECTOR, DOMAIN, {
			keyType: 'rsa',
			hash: 'sha1',
		});
		expect(allowed.ok).toBe(true);
	});

	it('service-forbidden: an explicit s= list naming neither email nor *', async () => {
		expect(
			await resolveDkimKey(
				answering([`v=DKIM1; k=rsa; s=other; p=${rsa2048}`]),
				SELECTOR,
				DOMAIN,
				RSA_SHA256
			)
		).toEqual({ ok: false, reason: 'service-forbidden' });
		for (const s of ['email', '*', 'other:email']) {
			const result = await resolveDkimKey(
				answering([`v=DKIM1; k=rsa; s=${s}; p=${rsa2048}`]),
				SELECTOR,
				DOMAIN,
				RSA_SHA256
			);
			expect(result.ok).toBe(true);
		}
	});

	it('bad-key: p= that does not decode to a public key', async () => {
		expect(
			await resolveDkimKey(answering(['v=DKIM1; k=rsa; p=AAAA']), SELECTOR, DOMAIN, RSA_SHA256)
		).toEqual({ ok: false, reason: 'bad-key' });
		expect(
			await resolveDkimKey(answering(['v=DKIM1; k=ed25519; p=AAAA']), SELECTOR, DOMAIN, {
				keyType: 'ed25519',
				hash: 'sha256',
			})
		).toEqual({ ok: false, reason: 'bad-key' });
	});

	it('weak-rsa: an RSA modulus below 1024 bits, with the record attached', async () => {
		const result = await resolveDkimKey(
			answering([`v=DKIM1; k=rsa; t=s; p=${rsa512}`]),
			SELECTOR,
			DOMAIN,
			RSA_SHA256
		);
		expect(result.ok).toBe(false);
		if (result.ok || result.reason !== 'weak-rsa') {
			throw new Error(`expected weak-rsa, got ${JSON.stringify(result)}`);
		}
		expect(result.record.flags).toEqual(['s']);
	});

	it('checks the record policy before decoding the key', async () => {
		// A restricted record reports the restriction, not its weak or
		// undecodable key.
		expect(
			await resolveDkimKey(
				answering([`v=DKIM1; k=rsa; s=other; p=${rsa512}`]),
				SELECTOR,
				DOMAIN,
				RSA_SHA256
			)
		).toEqual({ ok: false, reason: 'service-forbidden' });
		expect(
			await resolveDkimKey(
				answering([`v=DKIM1; k=rsa; h=sha1; p=AAAA`]),
				SELECTOR,
				DOMAIN,
				RSA_SHA256
			)
		).toEqual({ ok: false, reason: 'hash-forbidden' });
	});
});
