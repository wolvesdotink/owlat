/**
 * Sealed Mail key lifecycle — ROTATION + REVOCATION hard gate (E6, part a).
 *
 *   1. ROTATION mints a new active key, retires the old one to DECRYPT-ONLY, and
 *      records a signed rotation statement.
 *   2. The published rotation statement VERIFIES against the old key, and a peer
 *      pinned to the old key UPGRADES SILENTLY (the `signedRotation` TOFU
 *      transition — reusing the E2 pinning core).
 *   3. The old key still DECRYPTS (it is in the address's private-key set) but
 *      REFUSES TO SIGN new mail (the active signing row is the NEW key).
 *   4. The manifest serves the rotation statement in its `keyRotations` feed.
 *   5. REVOCATION stops publishing the address's public key.
 *
 * Keygen + signing run in the Node action plane, so INSTANCE_SECRET is stubbed.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import { evaluatePin } from '../pinning';
import { verifyRotationStatement } from '../discovery';
import { verifyManifest, type ManifestPayload } from '../manifest';
import { openSealed } from '../open';
import { openPrivateKey } from '../sealing';
import { modules, enableSealedMail } from './sealedMailTestHelpers';
import * as openpgp from 'openpgp';

describe('e2ee/lifecycle rotation + revocation', () => {
	beforeEach(() => {
		vi.stubEnv('INSTANCE_SECRET', 'unit-test-instance-secret-value');
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('rotates: new active key, old key retired to decrypt-only, statement recorded', async () => {
		const t = convexTest(schema, modules);
		const address = 'alice@sealed.example.com';

		const minted = await t.action(internal.e2ee.keysNode.mintForAddress, { address });
		const rotated = await t.action(internal.e2ee.lifecycleNode.runRotateAddressKey, { address });
		expect(rotated.rotated).toBe(true);
		expect(rotated.oldFingerprint).toBe(minted.fingerprint);
		expect(rotated.newFingerprint).not.toBe(minted.fingerprint);

		// Two rows now exist: one active (new), one retired decrypt-only (old).
		const rows = await t.run((ctx) =>
			ctx.db
				.query('keyVault')
				.withIndex('by_address', (q) => q.eq('address', address))
				.collect()
		);
		expect(rows).toHaveLength(2);
		const active = rows.filter((r) => r.isActive);
		expect(active).toHaveLength(1);
		expect(active[0]?.fingerprint).toBe(rotated.newFingerprint);
		const retired = rows.find((r) => !r.isActive);
		expect(retired?.fingerprint).toBe(minted.fingerprint);

		// The signing row (active) is the NEW key — the old key refuses to sign new
		// mail. The outbound sealer loads the signing key via getAddressKeyInternal,
		// which returns the ACTIVE row; the same active-row projection is published.
		const signingRow = await t.query(api.e2ee.keys.getPublicKeyByAddress, { address });
		expect(signingRow?.fingerprint).toBe(rotated.newFingerprint);
		const activeInternal = await t.query(internal.e2ee.keys.getAddressKeyInternal, { address });
		expect(activeInternal?.fingerprint).toBe(rotated.newFingerprint);

		// The old key remains available for DECRYPTION (both keys in the private set).
		const privateKeys = await t.run((ctx) =>
			ctx.db
				.query('keyVault')
				.withIndex('by_address', (q) => q.eq('address', address))
				.collect()
		);
		expect(privateKeys.map((r) => r.fingerprint).sort()).toEqual(
			[minted.fingerprint, rotated.newFingerprint].sort()
		);
	});

	it('a message sealed to the OLD key still opens after rotation, and one to the NEW key opens too', async () => {
		const t = convexTest(schema, modules);
		const address = 'erin@sealed.example.com';

		// Mint, then seal a fixture to the ORIGINAL (pre-rotation) published key.
		await t.action(internal.e2ee.keysNode.mintForAddress, { address });
		const oldPublic = (await t.query(api.e2ee.keys.getPublicKeyByAddress, { address }))!
			.publicKeyArmored;
		const sealedToOld = (await openpgp.encrypt({
			message: await openpgp.createMessage({ text: 'sealed under the old key' }),
			encryptionKeys: await openpgp.readKey({ armoredKey: oldPublic }),
			format: 'armored',
		})) as string;

		// Rotate — the old key is retired to decrypt-only, a new active key is minted.
		const rotated = await t.action(internal.e2ee.lifecycleNode.runRotateAddressKey, { address });
		expect(rotated.rotated).toBe(true);

		// Seal a second fixture to the NEW published key.
		const newPublic = (await t.query(api.e2ee.keys.getPublicKeyByAddress, { address }))!
			.publicKeyArmored;
		expect((await openpgp.readKey({ armoredKey: newPublic })).getFingerprint().toUpperCase()).toBe(
			rotated.newFingerprint
		);
		const sealedToNew = (await openpgp.encrypt({
			message: await openpgp.createMessage({ text: 'sealed under the new key' }),
			encryptionKeys: await openpgp.readKey({ armoredKey: newPublic }),
			format: 'armored',
		})) as string;

		// The exact multi-key decrypt surface the open plane uses: EVERY retained
		// private key for the address, active-first, opened from its at-rest envelope.
		const sealedKeys = await t.query(internal.e2ee.keys.getAddressPrivateKeysInternal, { address });
		expect(sealedKeys).toHaveLength(2);
		const recipientPrivateKeysArmored = sealedKeys.map((env) => openPrivateKey(env));

		// The OLD-key fixture opens via the retained decrypt-only key...
		const oldOutcome = await openSealed({ raw: sealedToOld, recipientPrivateKeysArmored });
		expect(oldOutcome.status).toBe('opened');
		if (oldOutcome.status === 'opened') {
			expect(oldOutcome.innerMime).toContain('sealed under the old key');
		}

		// ...and the NEW-key fixture opens via the active key.
		const newOutcome = await openSealed({ raw: sealedToNew, recipientPrivateKeysArmored });
		expect(newOutcome.status).toBe('opened');
		if (newOutcome.status === 'opened') {
			expect(newOutcome.innerMime).toContain('sealed under the new key');
		}
	});

	it('publishes a rotation statement that verifies and upgrades a peer pin silently', async () => {
		const t = convexTest(schema, modules);
		const address = 'bob@sealed.example.com';

		const minted = await t.action(internal.e2ee.keysNode.mintForAddress, { address });
		const oldPublicKeyArmored = (await t.query(api.e2ee.keys.getPublicKeyByAddress, { address }))!
			.publicKeyArmored;

		const rotated = await t.action(internal.e2ee.lifecycleNode.runRotateAddressKey, { address });

		const statementRow = await t.run((ctx) =>
			ctx.db
				.query('keyRotations')
				.withIndex('by_address', (q) => q.eq('address', address))
				.first()
		);
		expect(statementRow).not.toBeNull();
		expect(statementRow!.oldFingerprint).toBe(minted.fingerprint);
		expect(statementRow!.newFingerprint).toBe(rotated.newFingerprint);

		// The old key validly signed the old->new binding for this address.
		const ok = await verifyRotationStatement(
			oldPublicKeyArmored,
			{
				address,
				oldFingerprint: statementRow!.oldFingerprint,
				newFingerprint: statementRow!.newFingerprint,
				signature: statementRow!.signature,
			},
			address,
			minted.fingerprint,
			rotated.newFingerprint!
		);
		expect(ok).toBe(true);

		// A peer pinned to the OLD key, given a valid rotation signature, upgrades
		// SILENTLY to the new key (the E2 pinning state machine).
		const decision = evaluatePin({
			pinnedFingerprint: minted.fingerprint,
			observedFingerprint: rotated.newFingerprint!,
			rotationSignatureValid: true,
		});
		expect(decision.action).toBe('signedRotation');
		expect(decision.trusted).toBe(true);
		expect(decision.pinnedFingerprint).toBe(rotated.newFingerprint);

		// A tampered statement (wrong signature) must NOT verify (fail-closed).
		const bad = await verifyRotationStatement(
			oldPublicKeyArmored,
			{
				address,
				oldFingerprint: statementRow!.oldFingerprint,
				newFingerprint: statementRow!.newFingerprint,
				signature: statementRow!.signature.replace(/[A-Za-z]/, 'x'),
			},
			address,
			minted.fingerprint,
			rotated.newFingerprint!
		);
		expect(bad).toBe(false);
	});

	it('serves the rotation statement in the manifest keyRotations feed', async () => {
		const t = convexTest(schema, modules);
		await enableSealedMail(t);
		const address = 'carol@sealed.example.com';
		await t.action(internal.e2ee.keysNode.mintForAddress, { address });
		await t.action(internal.e2ee.keysNode.ensureInstanceIdentity, {});

		const before = await t.action(api.e2ee.manifest.getSignedManifest, {});
		expect(before).not.toBeNull();
		expect(before!.keyRotations ?? []).toHaveLength(0);

		const rotated = await t.action(internal.e2ee.lifecycleNode.runRotateAddressKey, { address });

		const after = await t.action(api.e2ee.manifest.getSignedManifest, {});
		expect(after).not.toBeNull();
		// The directory digest changed (address fingerprint changed) so the manifest
		// re-signed and now carries the feed.
		expect(after!.keyDirectoryDigest).not.toBe(before!.keyDirectoryDigest);
		expect(after!.keyRotations).toHaveLength(1);
		expect(after!.keyRotations![0]?.newFingerprint).toBe(rotated.newFingerprint);

		// The re-signed manifest payload still verifies against the instance key.
		const payload: ManifestPayload = {
			version: after!.version,
			instance: after!.instance,
			features: after!.features,
			keyDirectoryDigest: after!.keyDirectoryDigest,
			rotationFeedUrl: after!.rotationFeedUrl,
			generatedAt: after!.generatedAt,
		};
		expect(await verifyManifest(payload, after!.signature, after!.instance.publicKeyArmored)).toBe(
			true
		);
	});

	it('revocation stops publishing the address public key (WKD + discovery)', async () => {
		const t = convexTest(schema, modules);
		const address = 'dave@sealed.example.com';
		await t.action(internal.e2ee.keysNode.mintForAddress, { address });
		expect(await t.query(api.e2ee.keys.getPublicKeyByAddress, { address })).not.toBeNull();

		const result = await t.mutation(internal.e2ee.lifecycle.deactivateAddressKeys, { address });
		expect(result.deactivated).toBe(1);

		// No active key ⇒ no public key served, no WKD body.
		expect(await t.query(api.e2ee.keys.getPublicKeyByAddress, { address })).toBeNull();
		// The row is retained (decrypt-only) rather than deleted.
		const rows = await t.run((ctx) =>
			ctx.db
				.query('keyVault')
				.withIndex('by_address', (q) => q.eq('address', address))
				.collect()
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.isActive).toBe(false);
	});
});
