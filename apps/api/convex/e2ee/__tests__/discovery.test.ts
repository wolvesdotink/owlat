/**
 * Recipient-key discovery — the hard test gate for `e2ee/discovery.ts`. All
 * network is mocked (injected {@link DiscoveryDeps}); real OpenPGP fixture keys
 * (alice, bob) exercise the crypto. Covers:
 *   (a) manifest hit, WKD-only fallback, negative cache, TTL refresh, and the
 *       key<->address binding check;
 *   (b) SSRF negatives — a redirect (to 10.x / 169.254.x / localhost), plain
 *       http, an over-cap body, and a host resolving to a private address are
 *       all REJECTED (never silently treated as "no key").
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeAll } from 'vitest';
import * as openpgp from 'openpgp';
import {
	guardedFetchBytes,
	discoverKeyForAddress,
	keyCertifiesAddress,
	verifyRotationStatement,
	shouldRefetch,
	SsrfRejection,
	buildManifestUrl,
	buildWkdUrl,
	TTL_NEGATIVE_MS,
	type DiscoveryDeps,
	type RotationStatement,
} from '../discovery';
import { buildManifestPayload, signManifest } from '../manifest';

const keyPath = (name: string) =>
	new URL(`../../../fixtures/sealed-mail/pgp-mime/keys/${name}`, import.meta.url);
const alicePub = readFileSync(keyPath('alice.pub.asc'), 'utf8');
const aliceSec = readFileSync(keyPath('alice.sec.asc'), 'utf8');
const bobPub = readFileSync(keyPath('bob.pub.asc'), 'utf8');

const BOB = 'bob@sealed.example.org';
const BOB_DOMAIN = 'sealed.example.org';
const PUBLIC_IP = [{ address: '93.184.216.34' }];

let bobBinary: Uint8Array;
let aliceBinary: Uint8Array;
let bobFp: string;
let aliceFp: string;

beforeAll(async () => {
	bobBinary = (await openpgp.readKey({ armoredKey: bobPub })).write();
	aliceBinary = (await openpgp.readKey({ armoredKey: alicePub })).write();
	bobFp = (await openpgp.readKey({ armoredKey: bobPub })).getFingerprint().toUpperCase();
	aliceFp = (await openpgp.readKey({ armoredKey: alicePub })).getFingerprint().toUpperCase();
});

/** A signed instance manifest body (alice is the instance signer). */
async function signedManifestBody(): Promise<string> {
	const payload = buildManifestPayload({
		instanceFingerprint: aliceFp,
		instancePublicKeyArmored: alicePub,
		directory: [{ address: BOB, fingerprint: bobFp }],
		rotationFeedUrl: `https://${BOB_DOMAIN}/.well-known/owlat.json`,
		generatedAt: 1_800_000_000_000,
	});
	const signature = await signManifest(payload, aliceSec);
	return JSON.stringify({ ...payload, signature });
}

/**
 * A deps whose fetch routes on the URL. `wkd` chooses which key binary the WKD
 * endpoint serves; `manifest` optionally serves the signed manifest.
 */
function makeDeps(opts: {
	manifest?: string | number; // body string, or a status code (e.g. 404)
	wkd?: Uint8Array | number;
	lookup?: { address: string }[];
}): DiscoveryDeps {
	return {
		lookup: async () => opts.lookup ?? PUBLIC_IP,
		fetch: async (input) => {
			const url = String(input);
			if (url.includes('owlat.json')) {
				if (typeof opts.manifest === 'number') return new Response(null, { status: opts.manifest });
				if (opts.manifest === undefined) return new Response(null, { status: 404 });
				return new Response(opts.manifest, { status: 200 });
			}
			if (url.includes('/openpgpkey/hu/')) {
				if (opts.wkd === undefined || typeof opts.wkd === 'number') {
					return new Response(null, { status: typeof opts.wkd === 'number' ? opts.wkd : 404 });
				}
				return new Response(opts.wkd.slice(), { status: 200 });
			}
			return new Response(null, { status: 404 });
		},
	};
}

describe('e2ee/discovery URLs', () => {
	it('builds https manifest + WKD direct-method URLs', () => {
		expect(buildManifestUrl('Sealed.Example.ORG')).toBe(
			'https://sealed.example.org/.well-known/owlat.json'
		);
		expect(buildWkdUrl(BOB_DOMAIN, 'bob', 'abc123')).toBe(
			'https://sealed.example.org/.well-known/openpgpkey/hu/abc123?l=bob'
		);
	});
});

/**
 * Graft an UNCERTIFIED User ID for `email` onto `baseArmored` (a real key for a
 * DIFFERENT address). The bogus UID is inserted before the first subkey packet so
 * packet ordering stays valid and carries NO self-certification — the
 * hostile/compromised-WKD-host attack: a genuine key with a grafted, uncertified
 * binding to the victim address. No private key is needed to mount it.
 */
async function graftUncertifiedUid(baseArmored: string, email: string): Promise<string> {
	const list = (await openpgp.readKey({ armoredKey: baseArmored })).toPacketList();
	const firstSubkey = list.findIndex(
		(p) => p instanceof openpgp.PublicSubkeyPacket || p instanceof openpgp.SecretSubkeyPacket
	);
	const insertAt = firstSubkey === -1 ? list.length : firstSubkey;
	list.splice(insertAt, 0, openpgp.UserIDPacket.fromObject({ email }));
	return (await openpgp.readKey({ binaryKey: list.write() })).armor();
}

describe('e2ee/discovery key<->address binding', () => {
	it('accepts a key that certifies the exact address', async () => {
		expect(await keyCertifiesAddress(bobPub, BOB)).toBe(true);
	});
	it('rejects a key for a DIFFERENT address (the spoof case)', async () => {
		expect(await keyCertifiesAddress(alicePub, BOB)).toBe(false);
	});
	it('rejects a hybrid key: valid alice UID + UNCERTIFIED bob UID grafted on', async () => {
		// alice's real key with an uncertified `bob@...` UID grafted on. The address
		// is listed, and the key has a valid primary user (alice's own UID) — the old
		// key-wide `getPrimaryUser()` check would wrongly accept it and pin a
		// misdirected key. Binding the check to the MATCHING UID rejects it.
		const hybrid = await graftUncertifiedUid(alicePub, BOB);
		expect((await openpgp.readKey({ armoredKey: hybrid })).getUserIDs()).toContain(`<${BOB}>`);
		expect(await keyCertifiesAddress(hybrid, BOB)).toBe(false);
		// The genuine, self-certified alice UID on the same key is still honored.
		expect(await keyCertifiesAddress(hybrid, 'alice@sealed.example.com')).toBe(true);
	});
	it('rejects garbage', async () => {
		expect(await keyCertifiesAddress('not a key', BOB)).toBe(false);
	});
});

describe('e2ee/discovery fetch flow', () => {
	it('manifest hit: found via WKD, with the verified instance fingerprint', async () => {
		const deps = makeDeps({ manifest: await signedManifestBody(), wkd: bobBinary });
		const r = await discoverKeyForAddress(BOB, deps);
		expect(r.outcome).toBe('found');
		if (r.outcome !== 'found') throw new Error('expected found');
		expect(r.fingerprint).toBe(bobFp);
		expect(r.source).toBe('wkd');
		expect(r.instanceFingerprint).toBe(aliceFp);
	});

	it('WKD-only fallback: no manifest, still found (no instance fingerprint)', async () => {
		const deps = makeDeps({ manifest: 404, wkd: bobBinary });
		const r = await discoverKeyForAddress(BOB, deps);
		expect(r.outcome).toBe('found');
		if (r.outcome !== 'found') throw new Error('expected found');
		expect(r.fingerprint).toBe(bobFp);
		expect(r.instanceFingerprint).toBeUndefined();
	});

	it('rejects a WKD key whose UID does not match the address (binding fail)', async () => {
		const deps = makeDeps({ manifest: 404, wkd: aliceBinary });
		const r = await discoverKeyForAddress(BOB, deps);
		expect(r.outcome).toBe('notFound');
	});

	it('no key published: notFound', async () => {
		const deps = makeDeps({ manifest: 404, wkd: 404 });
		const r = await discoverKeyForAddress(BOB, deps);
		expect(r.outcome).toBe('notFound');
	});
});

describe('e2ee/discovery cache freshness', () => {
	const now = 1_800_000_000_000;
	it('refetches when there is no cached row', () => {
		expect(shouldRefetch(null, now)).toBe(true);
	});
	it('honors a still-valid negative cache (does not refetch)', () => {
		expect(shouldRefetch({ expiresAt: now + TTL_NEGATIVE_MS }, now)).toBe(false);
	});
	it('refetches once the TTL has expired', () => {
		expect(shouldRefetch({ expiresAt: now - 1 }, now)).toBe(true);
	});
});

describe('e2ee/discovery SSRF negatives', () => {
	const manifestUrl = buildManifestUrl(BOB_DOMAIN);

	it('rejects a plain-http URL', async () => {
		const deps = makeDeps({ wkd: bobBinary });
		await expect(
			guardedFetchBytes('http://sealed.example.org/.well-known/owlat.json', deps)
		).rejects.toBeInstanceOf(SsrfRejection);
	});

	for (const location of ['http://10.0.0.1/', 'https://169.254.169.254/', 'http://localhost/']) {
		it(`rejects a redirect (to ${location})`, async () => {
			const deps: DiscoveryDeps = {
				lookup: async () => PUBLIC_IP,
				fetch: async () => new Response(null, { status: 302, headers: { location } }),
			};
			await expect(guardedFetchBytes(manifestUrl, deps)).rejects.toBeInstanceOf(SsrfRejection);
		});
	}

	it('rejects a host that resolves to a private address', async () => {
		const deps: DiscoveryDeps = {
			lookup: async () => [{ address: '10.0.0.1' }],
			fetch: async () => new Response('x', { status: 200 }),
		};
		await expect(guardedFetchBytes(manifestUrl, deps)).rejects.toBeInstanceOf(SsrfRejection);
	});

	it('rejects an over-cap body (declared Content-Length)', async () => {
		const deps: DiscoveryDeps = {
			lookup: async () => PUBLIC_IP,
			fetch: async () =>
				new Response('x', { status: 200, headers: { 'content-length': String(1024 * 1024) } }),
		};
		await expect(guardedFetchBytes(manifestUrl, deps)).rejects.toBeInstanceOf(SsrfRejection);
	});

	it('rejects an over-cap body while streaming (no Content-Length)', async () => {
		const big = new Uint8Array(300 * 1024);
		const deps: DiscoveryDeps = {
			lookup: async () => PUBLIC_IP,
			fetch: async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(big);
							controller.close();
						},
					}),
					{ status: 200 }
				),
		};
		await expect(guardedFetchBytes(manifestUrl, deps)).rejects.toBeInstanceOf(SsrfRejection);
	});
});

describe('e2ee/discovery signed rotation statement', () => {
	const OLD = 'AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555';
	const NEW = '9999888877776666555544443333222211110000';

	async function sign(statement: Omit<RotationStatement, 'signature'>): Promise<string> {
		const text = [
			'owlat-key-rotation',
			statement.address.toLowerCase(),
			statement.oldFingerprint.toUpperCase(),
			statement.newFingerprint.toUpperCase(),
		].join('\n');
		return openpgp.sign({
			message: await openpgp.createMessage({ text }),
			signingKeys: await openpgp.readPrivateKey({ armoredKey: aliceSec }),
			detached: true,
			format: 'armored',
		});
	}

	it('accepts a statement validly signed by the old key binding old->new', async () => {
		const statement: RotationStatement = {
			address: BOB,
			oldFingerprint: OLD,
			newFingerprint: NEW,
			signature: await sign({ address: BOB, oldFingerprint: OLD, newFingerprint: NEW }),
		};
		expect(await verifyRotationStatement(alicePub, statement, BOB, OLD, NEW)).toBe(true);
	});

	it('rejects a statement whose observed fingerprint does not match', async () => {
		const statement: RotationStatement = {
			address: BOB,
			oldFingerprint: OLD,
			newFingerprint: NEW,
			signature: await sign({ address: BOB, oldFingerprint: OLD, newFingerprint: NEW }),
		};
		expect(await verifyRotationStatement(alicePub, statement, BOB, OLD, 'FFFF0000')).toBe(false);
	});

	it('rejects a statement signed by the WRONG key', async () => {
		const statement: RotationStatement = {
			address: BOB,
			oldFingerprint: OLD,
			newFingerprint: NEW,
			signature: await sign({ address: BOB, oldFingerprint: OLD, newFingerprint: NEW }),
		};
		expect(await verifyRotationStatement(bobPub, statement, BOB, OLD, NEW)).toBe(false);
	});
});
