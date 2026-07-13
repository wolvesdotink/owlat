/**
 * Two-instance E2EE proof — the headline evidence for the Sealed Mail plan
 * (2026-07-11, locked decisions D1/D2/D3/D4). Two INDEPENDENT convex-test
 * "instances" (separate `INSTANCE_SECRET`s, separate OpenPGP key material) talk
 * to each other over a LOOPBACK transport shim, exercising the real backend end
 * to end: key publication, cross-instance discovery, TOFU pinning, the outbound
 * seal decision, sealing, ingest-side opening, and the unsigned-key-change
 * conflict — all against genuine crypto, no network, no `gpg`.
 *
 * The shim mocks HTTP between the two instances two ways, and NOTHING else:
 *   - `node:dns/promises` `lookup` is mocked to a fixed PUBLIC-unicast address so
 *     the SSRF guard in `e2ee/discovery.ts` treats the peer host as routable
 *     (the guard itself still runs — a private/loopback resolution would reject);
 *   - global `fetch` is stubbed to serve one instance's `/.well-known/owlat.json`
 *     (its signed manifest) and `/.well-known/openpgpkey/hu/<hash>` (its WKD key
 *     body) straight out of the OTHER instance's convex-test database.
 *
 * THE FLOW (run ONCE in `beforeAll`, then asserted slice by slice):
 *   1. Instance A publishes keys for `alice@a.test` + its instance identity;
 *      instance B publishes keys for `bob@b.test` + its instance identity.
 *   2. A discovers bob (and B discovers alice) through the shim -> each PINS the
 *      peer key trust-on-first-use (`trusted`).
 *   3. A runs the REAL outbound seal decision (`getOutboundSealInputs` +
 *      `decideSeal`) and seals a message to bob with `sealMime` -> the WIRE
 *      ARTIFACT. It carries NO plaintext canary and NO real subject.
 *   4. The shim delivers the wire into B's real ingest action
 *      (`openInboundForMailbox`): B decrypts with bob's vault key, verifies A's
 *      signature against the alice key it pinned, and restores the protected
 *      headers (real subject, D4) — reporting `signatureValid: true`.
 *   5. B rotates bob's key (an UNSIGNED change). A re-discovers -> `keyChanged`,
 *      the old pin is retained, and A's NEXT send to bob refuses to seal
 *      (`reason: 'key_changed'`) rather than silently sealing to the new key.
 *   6. Cryptographic isolation: A's at-rest secret box cannot open B's sealed
 *      private key (separate `INSTANCE_SECRET`s), and the two instance
 *      identities are distinct keys.
 *
 * The full two-REAL-instance manual pass (staging VPS pair, Thunderbird/Proton
 * interop, external MTA-STS/DANE/TLS-RPT checkers, badge visual QA) lives in
 * `scripts/sealed-mail-qa.md` — the parts that need a GUI or a real network and
 * cannot be a CI fixture.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import type { DatabaseWriter } from '../../_generated/server';
import { createSecretBox } from '../../lib/credentialCrypto';
import { decideSeal } from '../../mail/sealPolicy';
import { sealMime } from '../seal';
import { openPrivateKey } from '../sealing';
import { modules, type ConvexTestCtx } from './sealedMailTestHelpers';

// The two instances resolve any peer host to a fixed PUBLIC-unicast address so
// the discovery SSRF guard (which rejects private/loopback resolutions) passes
// for `a.test` / `b.test`. Only `lookup` is overridden — the guard's blocklist
// logic is exercised for real against this allowed address.
vi.mock('node:dns/promises', () => {
	const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
	return { default: { lookup }, lookup };
});

const E2EE_KEY_BOX = { salt: 'owlat:e2ee:keys:salt:v1', info: 'owlat:e2ee:keys:v1' };

const A_SECRET = 'two-instance-proof-secret-ALPHA-instance';
const B_SECRET = 'two-instance-proof-secret-BRAVO-instance';

const ALICE = 'alice@a.test';
const BOB = 'bob@b.test';
const REAL_SUBJECT = 'Q3 sealed board numbers';
const CANARY = 'CANARY_TWO_INSTANCE_PROOF_8f2a41';

type Ctx = ConvexTestCtx;

/**
 * Run `fn` with `process.env.INSTANCE_SECRET` set to `secret` (a given instance's
 * box), restoring the previous value afterwards. The restore matters: unwrapped
 * steps (step-2 discovery, step-5 rediscover on A) must not silently inherit the
 * last-stubbed instance's secret — if a step ever grows a hidden dependence on the
 * ambient secret it fails loudly instead of using the wrong instance's box.
 */
async function asInstance<T>(secret: string, fn: () => Promise<T>): Promise<T> {
	const previous = process.env['INSTANCE_SECRET'];
	vi.stubEnv('INSTANCE_SECRET', secret);
	try {
		return await fn();
	} finally {
		vi.stubEnv('INSTANCE_SECRET', previous);
	}
}

/** The RFC 5322 message alice sends bob — the plaintext that gets sealed. */
function outboundRaw(): string {
	return [
		'Message-ID: <two-instance-0001@a.test>',
		'Date: Mon, 13 Jul 2026 09:00:00 +0000',
		`From: ${ALICE}`,
		`To: ${BOB}`,
		`Subject: ${REAL_SUBJECT}`,
		'MIME-Version: 1.0',
		'Content-Type: text/plain; charset=utf-8',
		'Content-Transfer-Encoding: 7bit',
		'',
		`Here are the ${CANARY} numbers you asked for.`,
		'',
	].join('\r\n');
}

/** Enable Sealed Mail (with its required flag chain) + seed one mailbox. */
async function provisionInstance(t: Ctx, address: string): Promise<void> {
	const domain = address.slice(address.lastIndexOf('@') + 1);
	const now = Date.now();
	await t.run(async (ctx) => {
		await ctx.db.insert('instanceSettings', {
			// sealedMail requires postbox + senderAuthBadges; seed the whole chain so
			// resolveFlags does not force it back off.
			featureFlags: { postbox: true, senderAuthBadges: true, sealedMail: true },
			createdAt: now,
		});
		await ctx.db.insert('mailboxes', {
			userId: 'user-1',
			organizationId: 'org-1',
			address,
			domain,
			status: 'active',
			usedBytes: 0,
			uidValidity: now,
			createdAt: now,
			updatedAt: now,
		});
	});
}

/**
 * The loopback HTTP shim: serves each instance's signed manifest + WKD key body
 * out of its convex-test DB, keyed by hostname. Returns a real `Response` so the
 * discovery reader (`guardedFetchBytes` -> `readCappedBytes`) streams it exactly
 * as it would a network body.
 */
function makeFetchShim(instances: Record<string, Ctx>) {
	return async (input: string | URL): Promise<Response> => {
		const url = new URL(typeof input === 'string' ? input : input.toString());
		const peer = instances[url.hostname];
		if (!peer) return new Response(null, { status: 404 });

		if (url.pathname === '/.well-known/owlat.json') {
			const manifest = await peer.action(api.e2ee.manifest.getSignedManifest, {});
			if (!manifest) return new Response(null, { status: 404 });
			return new Response(new TextEncoder().encode(JSON.stringify(manifest)), { status: 200 });
		}

		const wkd = url.pathname.match(/^\/\.well-known\/openpgpkey\/hu\/([^/]+)$/);
		if (wkd) {
			const wkdHash = wkd[1];
			if (!wkdHash) return new Response(null, { status: 404 });
			const body = await peer.query(api.e2ee.keys.getKeyForWkd, {
				domain: url.hostname,
				wkdHash,
			});
			if (!body) return new Response(null, { status: 404 });
			return new Response(new Uint8Array(Buffer.from(body.binaryBase64, 'base64')), {
				status: 200,
			});
		}
		return new Response(null, { status: 404 });
	};
}

// `ReturnType<typeof convexTest>` collapses convex-test's schema generic, so the
// `ctx.db` handed to `t.run` loses the schema and the index names below stop
// typechecking. Annotate the callback's `ctx.db` as the schema-aware
// `DatabaseWriter` (the same fix `sealedMailTestHelpers.ts` uses) to restore it.

/** The recipientKeys trust row an instance holds for a peer address. */
async function recipientRow(t: Ctx, address: string) {
	return await t.run((ctx: { db: DatabaseWriter }) =>
		ctx.db
			.query('recipientKeys')
			.withIndex('by_address', (q) => q.eq('address', address))
			.first()
	);
}

/** The keyVault address row for `address`. */
async function vaultRow(t: Ctx, address: string) {
	return await t.run((ctx: { db: DatabaseWriter }) =>
		ctx.db
			.query('keyVault')
			.withIndex('by_address', (q) => q.eq('address', address))
			.first()
	);
}

/** The single instance-identity keyVault row. */
async function instanceRow(t: Ctx) {
	return await t.run((ctx: { db: DatabaseWriter }) =>
		ctx.db
			.query('keyVault')
			.withIndex('by_kind', (q) => q.eq('kind', 'instance'))
			.first()
	);
}

/** Everything the flow captures for the assertions below. */
interface Captured {
	aliceFingerprint: string;
	bobFingerprint: string;
	bobFingerprintRotated: string;
	instanceAFingerprint: string;
	instanceBFingerprint: string;
	bobDiscoveryOutcome: string;
	aliceDiscoveryOutcome: string;
	wire: string;
	sealRecipientFingerprints: string[];
	sealSigningFingerprint: string;
	openedSealed: boolean;
	openedDecrypted: boolean;
	openedSignatureValid: boolean | undefined;
	openedSignerFingerprint: string | undefined;
	openedSignerInstance: string | undefined;
	openedSubject: string | undefined;
	openedText: string | undefined;
	pinnedAfterRotation: string | undefined;
	observedAfterRotation: string | undefined;
	outcomeAfterRotation: string | undefined;
	rediscoverOutcome: string;
	nextSendSeal: { seal: boolean; reason?: string };
	isolationOpensUnderOwnSecret: boolean;
	isolationOpenThrew: boolean;
}

let captured: Captured;
let instanceA: Ctx;
let instanceB: Ctx;

beforeAll(async () => {
	instanceA = convexTest(schema, modules);
	instanceB = convexTest(schema, modules);
	vi.stubGlobal('fetch', makeFetchShim({ 'a.test': instanceA, 'b.test': instanceB }));

	// 1. Publish keys on both instances (each under its OWN secret box) and warm
	//    the signed manifest so later shim fetches serve stable cached bytes
	//    without re-opening the instance private key under a foreign secret.
	await asInstance(A_SECRET, async () => {
		await provisionInstance(instanceA, ALICE);
		await instanceA.action(internal.e2ee.keysNode.runBackfill, {});
		await instanceA.action(api.e2ee.manifest.getSignedManifest, {});
	});
	await asInstance(B_SECRET, async () => {
		await provisionInstance(instanceB, BOB);
		await instanceB.action(internal.e2ee.keysNode.runBackfill, {});
		await instanceB.action(api.e2ee.manifest.getSignedManifest, {});
	});

	const alicePub = await instanceA.query(api.e2ee.keys.getPublicKeyByAddress, { address: ALICE });
	const bobPub = await instanceB.query(api.e2ee.keys.getPublicKeyByAddress, { address: BOB });
	const aInstance = await instanceRow(instanceA);
	const bInstance = await instanceRow(instanceB);
	if (!alicePub || !bobPub || !aInstance || !bInstance) {
		throw new Error('key publication did not produce the expected rows');
	}

	// 2. Cross-instance discovery through the shim -> TOFU pin on both sides.
	const bobDiscovery = await instanceA.action(internal.e2ee.discovery.discoverRecipientKey, {
		address: BOB,
	});
	const aliceDiscovery = await instanceB.action(internal.e2ee.discovery.discoverRecipientKey, {
		address: ALICE,
	});

	// 3. The REAL outbound seal decision, then seal with sealMime (what
	//    `mail/outbound.ts` hands the MTA). alice's signing key is opened from A's
	//    vault under A's secret, exactly as dispatch does.
	const { wire, recipientFingerprints, signingFingerprint } = await asInstance(
		A_SECRET,
		async () => {
			const sealInputs = await instanceA.query(
				internal.mail.outboundQueries.getOutboundSealInputs,
				{
					fromAddress: ALICE,
					recipients: [BOB],
				}
			);
			const decision = decideSeal(sealInputs);
			if (!decision.seal) {
				throw new Error(`expected a seal decision, got reason: ${decision.reason}`);
			}
			const signingRow = await instanceA.query(internal.e2ee.keys.getAddressKeyInternal, {
				address: ALICE,
			});
			if (!signingRow) throw new Error('alice signing key missing from vault');
			const signingKeyArmored = openPrivateKey(signingRow.sealedPrivateKey);
			const sealed = await sealMime(outboundRaw(), {
				recipientPublicKeysArmored: decision.recipientPublicKeysArmored,
				signingKeyArmored,
				protectSubject: true,
			});
			return {
				wire: sealed.mime,
				recipientFingerprints: sealed.encryptionInfo.recipientFingerprints,
				signingFingerprint: sealed.encryptionInfo.signingFingerprint,
			};
		}
	);

	// 4. Deliver the wire into B's REAL ingest action — decrypt + verify + restore.
	const opened = await asInstance(B_SECRET, () =>
		instanceB.action(internal.e2ee.open.openInboundForMailbox, {
			rawBytesBase64: Buffer.from(wire, 'utf-8').toString('base64'),
			recipientAddress: BOB,
			from: ALICE,
		})
	);
	if (!(opened.sealed && opened.decrypted)) {
		throw new Error('expected instance B to decrypt the sealed message');
	}
	// The mailbox result carries the full encryptionInfo union; narrow to the
	// decrypted branch so its verified-signature fields are readable.
	const openedInfo = opened.encryptionInfo;
	if (!openedInfo.decrypted) {
		throw new Error('decrypted result carried an undecrypted encryptionInfo');
	}

	// 5. Rotate bob's key on B (an UNSIGNED change: drop the row, mint anew), warm
	//    B's manifest again, then force A to re-discover.
	const bobRotatedFingerprint = await asInstance(B_SECRET, async () => {
		const row = await vaultRow(instanceB, BOB);
		if (row) await instanceB.run((ctx) => ctx.db.delete(row._id));
		const minted = await instanceB.action(internal.e2ee.keysNode.mintForAddress, { address: BOB });
		await instanceB.action(api.e2ee.manifest.getSignedManifest, {});
		return minted.fingerprint;
	});
	const rediscover = await instanceA.action(internal.e2ee.discovery.discoverRecipientKey, {
		address: BOB,
		force: true,
	});
	const rotatedRow = await recipientRow(instanceA, BOB);

	// A's next send must refuse to seal to the changed key.
	const nextSendInputs = await instanceA.query(
		internal.mail.outboundQueries.getOutboundSealInputs,
		{ fromAddress: ALICE, recipients: [BOB] }
	);
	const nextDecision = decideSeal(nextSendInputs);

	// 6. At-rest isolation: B's OWN box opens B's freshly-sealed private key
	//    (positive control — proves the box context matches the sealing site, so
	//    the negative result below can ONLY be the differing secret), while A's
	//    box cannot open it.
	const bobRotatedVault = await vaultRow(instanceB, BOB);
	if (!bobRotatedVault) throw new Error('rotated bob vault row missing');
	let isolationOpensUnderOwnSecret = false;
	try {
		const opened = createSecretBox(B_SECRET, E2EE_KEY_BOX).open(bobRotatedVault.sealedPrivateKey);
		isolationOpensUnderOwnSecret = opened.includes('BEGIN PGP PRIVATE KEY BLOCK');
	} catch {
		isolationOpensUnderOwnSecret = false;
	}
	let isolationOpenThrew = false;
	try {
		createSecretBox(A_SECRET, E2EE_KEY_BOX).open(bobRotatedVault.sealedPrivateKey);
	} catch {
		isolationOpenThrew = true;
	}

	captured = {
		aliceFingerprint: alicePub.fingerprint,
		bobFingerprint: bobPub.fingerprint,
		bobFingerprintRotated: bobRotatedFingerprint,
		instanceAFingerprint: aInstance.fingerprint,
		instanceBFingerprint: bInstance.fingerprint,
		bobDiscoveryOutcome: bobDiscovery.outcome,
		aliceDiscoveryOutcome: aliceDiscovery.outcome,
		wire,
		sealRecipientFingerprints: recipientFingerprints,
		sealSigningFingerprint: signingFingerprint,
		openedSealed: opened.sealed,
		openedDecrypted: opened.decrypted,
		openedSignatureValid: openedInfo.signatureValid,
		openedSignerFingerprint: openedInfo.signerFingerprint,
		openedSignerInstance: openedInfo.signerInstance,
		openedSubject: opened.subject,
		openedText: opened.text,
		pinnedAfterRotation: rotatedRow?.pinnedFingerprint,
		observedAfterRotation: rotatedRow?.observedFingerprint,
		outcomeAfterRotation: rotatedRow?.outcome,
		rediscoverOutcome: rediscover.outcome,
		nextSendSeal: nextDecision.seal ? { seal: true } : { seal: false, reason: nextDecision.reason },
		isolationOpensUnderOwnSecret,
		isolationOpenThrew,
	};
}, 60_000);

afterAll(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe('e2ee/twoInstance · two-instance E2EE proof', () => {
	it('A discovers + TOFU-pins B’s address key on first contact (trusted)', () => {
		expect(captured.bobDiscoveryOutcome).toBe('trusted');
		expect(captured.aliceDiscoveryOutcome).toBe('trusted');
	});

	it('the WIRE ARTIFACT is ciphertext — no plaintext canary or real subject leaks', () => {
		// The message alice hands the MTA is PGP/MIME ciphertext…
		expect(captured.wire).toContain(
			'Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"'
		);
		expect(captured.wire).toContain('-----BEGIN PGP MESSAGE-----');
		// …the outer subject is the literal placeholder (D4)…
		expect(captured.wire).toMatch(/^Subject: \.\.\.\r?$/m);
		// …and NOTHING sensitive survives in the clear.
		expect(captured.wire).not.toContain(CANARY);
		expect(captured.wire).not.toContain(REAL_SUBJECT);
	});

	it('B opens the sealed message: decrypts, verifies A’s signature, restores headers', () => {
		expect(captured.openedSealed).toBe(true);
		expect(captured.openedDecrypted).toBe(true);
		// Honest badge state is reachable ONLY here: decrypted AND signature-verified
		// against the alice key B pinned by itself.
		expect(captured.openedSignatureValid).toBe(true);
		expect(captured.openedSignerFingerprint).toBe(captured.aliceFingerprint);
		expect(captured.openedSignerInstance).toBe('a.test');
		// Protected headers (D4): the real subject + body travelled INSIDE.
		expect(captured.openedSubject).toBe(REAL_SUBJECT);
		expect(captured.openedText).toContain(CANARY);
	});

	it('encryptionInfo honestly records exactly the keys used', () => {
		// Sealed to bob's pinned key, signed by alice's — no more, no less.
		expect(captured.sealRecipientFingerprints).toEqual([captured.bobFingerprint]);
		expect(captured.sealSigningFingerprint).toBe(captured.aliceFingerprint);
	});

	it('an UNSIGNED key-swap on B moves A into keyChanged and keeps the OLD pin', () => {
		expect(captured.rediscoverOutcome).toBe('keyChanged');
		expect(captured.outcomeAfterRotation).toBe('keyChanged');
		// The old pin is retained (never silently re-pinned)…
		expect(captured.pinnedAfterRotation).toBe(captured.bobFingerprint);
		// …while the conflicting new key rides along as the observed key.
		expect(captured.observedAfterRotation).toBe(captured.bobFingerprintRotated);
		expect(captured.bobFingerprintRotated).not.toBe(captured.bobFingerprint);
	});

	it('A’s NEXT send refuses to seal to the changed key (reason: key_changed)', () => {
		expect(captured.nextSendSeal.seal).toBe(false);
		expect(captured.nextSendSeal.reason).toBe('key_changed');
	});

	it('the two instances are cryptographically isolated (separate at-rest secrets + keys)', () => {
		expect(A_SECRET).not.toBe(B_SECRET);
		// Positive control: B's OWN box DOES open B's sealed private key, proving the
		// box context matches the sealing site — so the failure below can only be the
		// differing secret, never a drifted salt/info literal.
		expect(captured.isolationOpensUnderOwnSecret).toBe(true);
		// A's box cannot open B's sealed private key — the vaults are independent.
		expect(captured.isolationOpenThrew).toBe(true);
		// Distinct instance signing identities.
		expect(captured.instanceAFingerprint).not.toBe(captured.instanceBFingerprint);
		expect(captured.instanceAFingerprint).toMatch(/^[0-9A-F]{40}$/);
		expect(captured.instanceBFingerprint).toMatch(/^[0-9A-F]{40}$/);
	});
});
