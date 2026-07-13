/**
 * "Encryption keys published" self-check — the readiness verdict logic.
 *
 * Exercises the pure {@link checkEncryptionKeysPublished} against an injected
 * `fetch` that serves this instance's own `/.well-known` endpoints. Locks the
 * HONESTY CONTRACT: `published` is true ONLY when the served manifest is
 * reachable AND its signature verifies against its own served instance key AND it
 * advertises `features.e2ee` AND the WKD policy is reachable AND a real address
 * key is served over WKD `hu/<hash>`. Every failure mode degrades honestly rather
 * than throwing.
 *
 * Uses the checked-in real OpenPGP fixture keys (alice as the instance signer,
 * bob as an unrelated key that must NOT validate against alice's manifest).
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import * as openpgp from 'openpgp';
import { buildManifestPayload, signManifest, type SignedManifest } from '../manifest';
import { checkEncryptionKeysPublished, type SelfCheckInput } from '../selfCheck';

const keyPath = (name: string) =>
	new URL(`../../../fixtures/sealed-mail/pgp-mime/keys/${name}`, import.meta.url);
const aliceSec = readFileSync(keyPath('alice.sec.asc'), 'utf8');
const alicePub = readFileSync(keyPath('alice.pub.asc'), 'utf8');
const bobSec = readFileSync(keyPath('bob.sec.asc'), 'utf8');

const SITE_URL = 'https://sealed.example.com';
const ADDRESS = 'alice@sealed.example.com';

const DIRECTORY: SelfCheckInput['directory'] = [{ address: ADDRESS }];

async function fingerprintOf(armored: string): Promise<string> {
	return (await openpgp.readKey({ armoredKey: armored })).getFingerprint().toUpperCase();
}

/** Build a served manifest signed by `signerSec`, advertising `servedPub` as the instance key. */
async function buildServedManifest(opts: {
	signerSec: string;
	servedPub: string;
	e2ee?: number;
}): Promise<SignedManifest> {
	const payload = buildManifestPayload({
		instanceFingerprint: await fingerprintOf(opts.servedPub),
		instancePublicKeyArmored: opts.servedPub,
		directory: [{ address: ADDRESS, fingerprint: await fingerprintOf(opts.servedPub) }],
		rotationFeedUrl: `${SITE_URL}/.well-known/owlat.json`,
		generatedAt: 1_700_000_000_000,
	});
	if (opts.e2ee !== undefined) payload.features.e2ee = opts.e2ee;
	const signature = await signManifest(payload, opts.signerSec);
	return { ...payload, signature };
}

/** A fake `fetch` routing by well-known path. Each endpoint's response is configurable. */
function fakeFetch(routes: {
	manifest?: SignedManifest | null;
	policyStatus?: number;
	huBody?: Uint8Array | null;
}): (url: string) => Promise<Response> {
	return (url: string) => {
		if (url.endsWith('/.well-known/owlat.json')) {
			if (!routes.manifest) return Promise.resolve(new Response('', { status: 404 }));
			return Promise.resolve(
				new Response(JSON.stringify(routes.manifest), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				})
			);
		}
		if (url.endsWith('/.well-known/openpgpkey/policy')) {
			return Promise.resolve(new Response('', { status: routes.policyStatus ?? 200 }));
		}
		if (url.includes('/.well-known/openpgpkey/hu/')) {
			if (!routes.huBody) return Promise.resolve(new Response('', { status: 404 }));
			return Promise.resolve(new Response(routes.huBody, { status: 200 }));
		}
		return Promise.resolve(new Response('', { status: 404 }));
	};
}

const input = (overrides: Partial<SelfCheckInput> = {}): SelfCheckInput => ({
	siteUrl: SITE_URL,
	localPublished: true,
	directory: DIRECTORY,
	...overrides,
});

describe('e2ee/selfCheck checkEncryptionKeysPublished', () => {
	it('reports published when the manifest, policy, and a WKD key are all served correctly', async () => {
		const manifest = await buildServedManifest({ signerSec: aliceSec, servedPub: alicePub });
		const result = await checkEncryptionKeysPublished(input(), {
			fetch: fakeFetch({ manifest, policyStatus: 200, huBody: new Uint8Array([1, 2, 3]) }),
		});
		expect(result.published).toBe(true);
		expect(result.manifest.reachable).toBe(true);
		expect(result.manifest.signatureValid).toBe(true);
		expect(result.manifest.featuresE2ee).toBe(true);
		expect(result.manifest.fingerprint).toBe(await fingerprintOf(alicePub));
		expect(result.wkd.policyReachable).toBe(true);
		expect(result.wkd.keyServed).toBe(true);
		expect(result.wkd.checkedAddress).toBe(ADDRESS);
		expect(result.localPublished).toBe(true);
	});

	it('is not published when the manifest 404s', async () => {
		const result = await checkEncryptionKeysPublished(input(), {
			fetch: fakeFetch({ manifest: null, policyStatus: 200, huBody: new Uint8Array([1]) }),
		});
		expect(result.manifest.reachable).toBe(false);
		expect(result.manifest.signatureValid).toBe(false);
		expect(result.published).toBe(false);
	});

	it('rejects a manifest whose signature does not verify against its served key', async () => {
		// Signed by bob but serving alice's public key — the honesty contract must
		// catch the mismatch and refuse to call it published.
		const manifest = await buildServedManifest({ signerSec: bobSec, servedPub: alicePub });
		const result = await checkEncryptionKeysPublished(input(), {
			fetch: fakeFetch({ manifest, policyStatus: 200, huBody: new Uint8Array([1]) }),
		});
		expect(result.manifest.reachable).toBe(true);
		expect(result.manifest.signatureValid).toBe(false);
		expect(result.published).toBe(false);
	});

	it('is not published when the manifest does not advertise features.e2ee', async () => {
		const manifest = await buildServedManifest({
			signerSec: aliceSec,
			servedPub: alicePub,
			e2ee: 0,
		});
		const result = await checkEncryptionKeysPublished(input(), {
			fetch: fakeFetch({ manifest, policyStatus: 200, huBody: new Uint8Array([1]) }),
		});
		expect(result.manifest.featuresE2ee).toBe(false);
		expect(result.published).toBe(false);
	});

	it('is not published when the WKD policy is unreachable', async () => {
		const manifest = await buildServedManifest({ signerSec: aliceSec, servedPub: alicePub });
		const result = await checkEncryptionKeysPublished(input(), {
			fetch: fakeFetch({ manifest, policyStatus: 404, huBody: new Uint8Array([1]) }),
		});
		expect(result.wkd.policyReachable).toBe(false);
		expect(result.published).toBe(false);
	});

	it('is not published when the WKD key body is empty', async () => {
		const manifest = await buildServedManifest({ signerSec: aliceSec, servedPub: alicePub });
		const result = await checkEncryptionKeysPublished(input(), {
			fetch: fakeFetch({ manifest, policyStatus: 200, huBody: new Uint8Array([]) }),
		});
		expect(result.wkd.keyServed).toBe(false);
		expect(result.published).toBe(false);
	});

	it('skips the WKD probe when no directory address matches the site host', async () => {
		const manifest = await buildServedManifest({ signerSec: aliceSec, servedPub: alicePub });
		const result = await checkEncryptionKeysPublished(
			input({ directory: [{ address: 'alice@other.example.org' }] }),
			{ fetch: fakeFetch({ manifest, policyStatus: 200, huBody: new Uint8Array([1]) }) }
		);
		expect(result.wkd.checkedAddress).toBeUndefined();
		expect(result.wkd.keyServed).toBe(false);
		expect(result.published).toBe(false);
	});

	it('never throws when fetch rejects — degrades to not reachable', async () => {
		const failing = () => Promise.reject(new Error('network down'));
		const result = await checkEncryptionKeysPublished(input(), { fetch: failing });
		expect(result.manifest.reachable).toBe(false);
		expect(result.wkd.policyReachable).toBe(false);
		expect(result.wkd.keyServed).toBe(false);
		expect(result.published).toBe(false);
	});
});
