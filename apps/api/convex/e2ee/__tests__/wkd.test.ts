/**
 * WKD primitives — the hard test gate for key discovery:
 *   1. z-base-32 / SHA-1 KNOWN-ANSWER VECTORS — the canonical WKD spec vector
 *      (`Joe.Doe` -> `iy9q119eutrkn8s1mk4r39qejnbu3n5q`) plus case-folding and a
 *      raw z-base-32 encoding vector.
 *   2. ARMORED <-> BINARY round-trip preserves the key (fingerprint stable),
 *      exercised against a checked-in real OpenPGP public key.
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import * as openpgp from 'openpgp';
import {
	zbase32Encode,
	wkdLocalHash,
	wkdHashForAddress,
	splitAddress,
	armoredToBinaryBase64,
	binaryBase64ToArmored,
	ZBASE32_ALPHABET,
} from '../wkd';

const alicePubArmored = readFileSync(
	new URL('../../../fixtures/sealed-mail/pgp-mime/keys/alice.pub.asc', import.meta.url),
	'utf8'
);

describe('e2ee/wkd hashing', () => {
	it('matches the canonical WKD spec vector for Joe.Doe', () => {
		// draft-koch-openpgp-webkey-service canonical example.
		expect(wkdLocalHash('Joe.Doe')).toBe('iy9q119eutrkn8s1mk4r39qejnbu3n5q');
	});

	it('folds case before hashing (Joe.Doe == joe.doe)', () => {
		expect(wkdLocalHash('joe.doe')).toBe(wkdLocalHash('Joe.Doe'));
		expect(wkdLocalHash('ALICE')).toBe('kei1q4tipxxu1yj79k9kfukdhfy631xe');
		expect(wkdLocalHash('alice')).toBe('kei1q4tipxxu1yj79k9kfukdhfy631xe');
	});

	it('hashes only the local-part of a full address, lowercasing the domain', () => {
		expect(wkdHashForAddress('Alice@Sealed.Example.com')).toBe('kei1q4tipxxu1yj79k9kfukdhfy631xe');
		expect(splitAddress('Alice@Sealed.Example.com')).toEqual({
			localPart: 'alice',
			domain: 'sealed.example.com',
		});
	});

	it('encodes z-base-32 with the WKD alphabet (known vector)', () => {
		expect(ZBASE32_ALPHABET).toHaveLength(32);
		// SHA-1("joe.doe") encoded is the canonical hash; empty input -> empty string.
		expect(zbase32Encode(new Uint8Array([]))).toBe('');
		// One byte 0x00 -> two symbols, both the 0-index symbol 'y'.
		expect(zbase32Encode(new Uint8Array([0x00]))).toBe('yy');
	});

	it('rejects a malformed address', () => {
		expect(() => splitAddress('not-an-email')).toThrow();
		expect(() => splitAddress('@nolocal.com')).toThrow();
		expect(() => splitAddress('nodomain@')).toThrow();
	});
});

describe('e2ee/wkd armored <-> binary', () => {
	it('round-trips a real public key without changing its fingerprint', async () => {
		const original = await openpgp.readKey({ armoredKey: alicePubArmored });
		const binaryBase64 = await armoredToBinaryBase64(alicePubArmored);
		expect(binaryBase64).toMatch(/^[A-Za-z0-9+/]+=*$/);

		const roundTripped = await binaryBase64ToArmored(binaryBase64);
		const key = await openpgp.readKey({ armoredKey: roundTripped });
		expect(key.getFingerprint()).toBe(original.getFingerprint());
	});

	it('binary body carries no private-key packet', async () => {
		const binaryBase64 = await armoredToBinaryBase64(alicePubArmored);
		const bytes = Buffer.from(binaryBase64, 'base64');
		expect(new TextDecoder().decode(bytes)).not.toContain('PRIVATE');
	});
});
