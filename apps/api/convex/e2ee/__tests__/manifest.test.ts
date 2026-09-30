/**
 * Signed instance manifest — the hard test gate for TOFU discovery:
 *   1. SIGNATURE VERIFIES against the served instance public key, and FAILS
 *      against a different key (a spoofed signer can't forge the manifest).
 *   2. TAMPERING with the payload breaks verification.
 *   3. keyDirectoryDigest matches the directory contents, is order-independent,
 *      and changes when the directory changes.
 *
 * Uses the checked-in real OpenPGP fixture keys (alice as the instance signer).
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import * as openpgp from 'openpgp';
import {
	buildManifestPayload,
	signManifest,
	verifyManifest,
	keyDirectoryDigest,
	canonicalManifest,
	MANIFEST_VERSION,
	type KeyDirectoryEntry,
	type ManifestPayload,
} from '../manifest';

const keyPath = (name: string) =>
	new URL(`../../../fixtures/sealed-mail/pgp-mime/keys/${name}`, import.meta.url);
const aliceSec = readFileSync(keyPath('alice.sec.asc'), 'utf8');
const alicePub = readFileSync(keyPath('alice.pub.asc'), 'utf8');
const bobPub = readFileSync(keyPath('bob.pub.asc'), 'utf8');

const DIRECTORY: KeyDirectoryEntry[] = [
	{ address: 'bob@sealed.example.com', fingerprint: 'BBBB1111' },
	{ address: 'alice@sealed.example.com', fingerprint: 'AAAA2222' },
];

async function fingerprintOf(armored: string): Promise<string> {
	return (await openpgp.readKey({ armoredKey: armored })).getFingerprint().toUpperCase();
}

describe('e2ee/manifest signing', () => {
	it('produces a manifest whose signature verifies against the served pubkey', async () => {
		const payload = buildManifestPayload({
			instanceFingerprint: await fingerprintOf(alicePub),
			instancePublicKeyArmored: alicePub,
			directory: DIRECTORY,
			rotationFeedUrl: 'https://sealed.example.com/.well-known/owlat.json',
			generatedAt: 1_800_000_000_000,
		});
		expect(payload.version).toBe(MANIFEST_VERSION);
		expect(payload.features.e2ee).toBe(1);

		const signature = await signManifest(payload, aliceSec);
		expect(await verifyManifest(payload, signature, payload.instance.publicKeyArmored)).toBe(true);
	});

	it('rejects a signature checked against a different key', async () => {
		const payload = buildManifestPayload({
			instanceFingerprint: await fingerprintOf(alicePub),
			instancePublicKeyArmored: alicePub,
			directory: DIRECTORY,
			rotationFeedUrl: 'https://sealed.example.com/.well-known/owlat.json',
			generatedAt: 1_800_000_000_000,
		});
		const signature = await signManifest(payload, aliceSec);
		expect(await verifyManifest(payload, signature, bobPub)).toBe(false);
	});

	it('rejects a tampered payload', async () => {
		const payload = buildManifestPayload({
			instanceFingerprint: await fingerprintOf(alicePub),
			instancePublicKeyArmored: alicePub,
			directory: DIRECTORY,
			rotationFeedUrl: 'https://sealed.example.com/.well-known/owlat.json',
			generatedAt: 1_800_000_000_000,
		});
		const signature = await signManifest(payload, aliceSec);
		const tampered = { ...payload, keyDirectoryDigest: '0'.repeat(64) };
		expect(await verifyManifest(tampered, signature, alicePub)).toBe(false);
	});
});

describe('e2ee/manifest keyDirectoryDigest', () => {
	it('is order-independent and matches recomputation', () => {
		const forward = keyDirectoryDigest(DIRECTORY);
		const reversed = keyDirectoryDigest([...DIRECTORY].reverse());
		expect(forward).toBe(reversed);
		expect(forward).toMatch(/^[0-9a-f]{64}$/);
	});

	it('changes when the directory changes', () => {
		const base = keyDirectoryDigest(DIRECTORY);
		const changed = keyDirectoryDigest([
			...DIRECTORY,
			{ address: 'carol@sealed.example.com', fingerprint: 'CCCC3333' },
		]);
		expect(changed).not.toBe(base);
	});

	it('folds case so equivalent directories digest identically', () => {
		const lower = keyDirectoryDigest([{ address: 'a@x.com', fingerprint: 'abcd' }]);
		const upper = keyDirectoryDigest([{ address: 'A@X.com', fingerprint: 'ABCD' }]);
		expect(lower).toBe(upper);
	});

	it('canonical serialization is stable and key-sorted', () => {
		const payload = buildManifestPayload({
			instanceFingerprint: 'AABB',
			instancePublicKeyArmored: 'PUB',
			directory: DIRECTORY,
			rotationFeedUrl: 'https://x/.well-known/owlat.json',
			generatedAt: 1,
		});
		const canonical = canonicalManifest(payload);
		// Keys appear in sorted order — `features` before `instance` before `version`.
		expect(canonical.indexOf('"features"')).toBeLessThan(canonical.indexOf('"instance"'));
		expect(canonical.indexOf('"instance"')).toBeLessThan(canonical.indexOf('"version"'));
	});
});

/**
 * The signed bytes are a contract between instances on different releases: a
 * peer re-derives them from the fetched JSON to verify our signature. These
 * vectors were produced by the serializer that preceded the shared
 * `canonicalJson`, so any change to the bytes fails here before it breaks
 * verification between an upgraded and a not-yet-upgraded instance.
 */
describe('e2ee/manifest canonical bytes (golden vectors)', () => {
	const payload = buildManifestPayload({
		instanceFingerprint: 'aabb',
		instancePublicKeyArmored: 'PUB',
		directory: [
			{ address: 'bob@example.com', fingerprint: 'bbbb1111' },
			{ address: 'alice@example.com', fingerprint: 'aaaa2222' },
		],
		rotationFeedUrl: 'https://owlat.example.com/.well-known/owlat.json',
		generatedAt: 1_800_000_000_000,
	});

	it('serializes a payload to the pinned bytes', () => {
		expect(canonicalManifest(payload)).toBe(
			'{"features":{"e2ee":1},"generatedAt":1800000000000,"instance":{"fingerprint":"AABB","publicKeyArmored":"PUB"},"keyDirectoryDigest":"017cfc7533f0c60503269dcf9ec8326dea70c30671428158ded4e21319a32001","rotationFeedUrl":"https://owlat.example.com/.well-known/owlat.json","version":1}'
		);
	});

	it('serializes extra fields a peer on a newer release may send to the pinned bytes', () => {
		// verifyFetchedManifest passes the fetched `instance` object through whole.
		const peer = {
			...payload,
			instance: {
				publicKeyArmored: 'PUB',
				fingerprint: 'AABB',
				ｚ: 'wide',
				'10': 1,
				'2': [true, null, 1.5],
				label: 'Ünïcode "quoted" \u2028',
			},
		} as unknown as ManifestPayload;
		expect(canonicalManifest(peer)).toBe(
			'{"features":{"e2ee":1},"generatedAt":1800000000000,"instance":{"10":1,"2":[true,null,1.5],"fingerprint":"AABB","label":"Ünïcode \\"quoted\\" \u2028","publicKeyArmored":"PUB","ｚ":"wide"},"keyDirectoryDigest":"017cfc7533f0c60503269dcf9ec8326dea70c30671428158ded4e21319a32001","rotationFeedUrl":"https://owlat.example.com/.well-known/owlat.json","version":1}'
		);
	});

	it('verifies a signature made by the previous serializer', async () => {
		const signed = buildManifestPayload({
			instanceFingerprint: await fingerprintOf(alicePub),
			instancePublicKeyArmored: alicePub,
			directory: DIRECTORY,
			rotationFeedUrl: 'https://sealed.example.com/.well-known/owlat.json',
			generatedAt: 1_800_000_000_000,
		});
		const previousReleaseSignature = [
			'-----BEGIN PGP SIGNATURE-----',
			'',
			'wrsEARYKAG0Fgmq9HEQJEJmLeayO8zevRRQAAAAAABwAIHNhbHRAbm90YXRp',
			'b25zLm9wZW5wZ3Bqcy5vcmelb50K/BOrI8IGNoHFMnN2zxDZ9CrsAHt4Gii0',
			'o51IGxYhBPOmAJAMZnnVLeaXsZmLeayO8zevAAAhmQEAoFBPcfQEWupkjN6U',
			'N9mZpxKr4ia90W2MMiGGaVpzU3wBAMv3RTAINR+JuLAYQx2ZOkK6WyRHFx7r',
			'jtBL9DJndm0N',
			'=CJzQ',
			'-----END PGP SIGNATURE-----',
			'',
		].join('\n');
		expect(await verifyManifest(signed, previousReleaseSignature, alicePub)).toBe(true);
	});
});
