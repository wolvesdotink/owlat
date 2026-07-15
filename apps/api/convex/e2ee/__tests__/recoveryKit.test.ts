/**
 * Sealed Mail recovery kit — hard gate (E6, part b; locked decision D7).
 *
 *   1. PURE assembly — the plain-language instructions + filename are exactly the
 *      agreed copy (asserted verbatim, the honesty audit).
 *   2. EXPORT -> WIPE -> IMPORT -> an OLD sealed fixture still OPENS. Proves the
 *      recovery kit is a complete, self-sufficient backup of the address's key
 *      with no server-side escrow needed.
 *   3. IMPORT rejects a key that does not certify the address.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as openpgp from 'openpgp';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import { openSealed } from '../open';
import { openPrivateKey } from '../sealing';
import {
	buildRecoveryKit,
	buildRecoveryKitInstructions,
	groupFingerprint,
	recoveryKitFilename,
} from '../recoveryKit';
import { enableSealedMail, modules } from './sealedMailTestHelpers';

describe('e2ee/recoveryKit pure assembly', () => {
	it('groups a fingerprint into 4-char blocks', () => {
		expect(groupFingerprint('a1b2c3d4e5f6')).toBe('A1B2 C3D4 E5F6');
	});

	it('derives a filesystem-safe filename from the address', () => {
		expect(recoveryKitFilename('Alice@Sealed.Example.com')).toBe(
			'owlat-recovery-kit-alice@sealed.example.com.asc'
		);
	});

	it('writes plain-language instructions with the no-escrow warning (verbatim)', () => {
		const text = buildRecoveryKitInstructions({
			address: 'alice@sealed.example.com',
			fingerprint: 'A1B2C3D4',
		});
		expect(text).toContain('Recovery kit for alice@sealed.example.com');
		expect(text).toContain(
			'This file is the private key that unlocks sealed mail sent to this address.'
		);
		expect(text).toContain('There is no master copy anywhere.');
		expect(text).toContain('import this file in Settings to restore access.');
		// No crypto jargon leaks beyond the agreed wording.
		expect(text).not.toMatch(/OpenPGP|AES|HKDF|cipher/i);
	});

	it('assembles a full kit', () => {
		const kit = buildRecoveryKit({
			address: 'bob@sealed.example.com',
			fingerprint: 'FF00',
			privateKeyArmored: '-----BEGIN PGP PRIVATE KEY BLOCK-----',
			generatedAt: 123,
		});
		expect(kit.filename).toBe('owlat-recovery-kit-bob@sealed.example.com.asc');
		expect(kit.instructions).toContain('Recovery kit for bob@sealed.example.com');
		expect(kit.generatedAt).toBe(123);
	});
});

describe('e2ee/recoveryKit export -> wipe -> import round-trip', () => {
	beforeEach(() => {
		vi.stubEnv('INSTANCE_SECRET', 'unit-test-instance-secret-value');
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('opens an old sealed fixture after export, wipe, and import', async () => {
		const t = convexTest(schema, modules);
		await enableSealedMail(t);
		const address = 'recover@sealed.example.com';

		// Mint the address key and seal a fixture message TO its published public key.
		const minted = await t.action(internal.e2ee.keysNode.mintForAddress, { address });
		const published = (await t.query(api.e2ee.keys.getPublicKeyByAddress, { address }))!;
		const sealedFixture = (await openpgp.encrypt({
			message: await openpgp.createMessage({ text: 'the sealed body' }),
			encryptionKeys: await openpgp.readKey({ armoredKey: published.publicKeyArmored }),
			format: 'armored',
		})) as string;

		// Export the recovery kit (the ONLY private-key egress).
		const kit = await t.action(internal.e2ee.lifecycleNode.runExportRecoveryKit, { address });
		expect(kit).not.toBeNull();
		expect(kit!.fingerprint).toBe(minted.fingerprint);
		expect(kit!.privateKeyArmored).toContain('PRIVATE KEY');

		// WIPE the vault — as if the instance was rebuilt with sealed history but no keys.
		await t.run(async (ctx) => {
			const rows = await ctx.db
				.query('keyVault')
				.withIndex('by_address', (q) => q.eq('address', address))
				.collect();
			for (const row of rows) await ctx.db.delete(row._id);
		});
		expect(await t.query(api.e2ee.keys.getPublicKeyByAddress, { address })).toBeNull();

		// IMPORT the recovery kit — restores the active key.
		const imported = await t.action(internal.e2ee.lifecycleNode.runImportRecoveryKit, {
			address,
			privateKeyArmored: kit!.privateKeyArmored,
		});
		expect(imported.imported).toBe(true);
		expect(imported.fingerprint).toBe(minted.fingerprint);

		// The OLD sealed fixture still opens with the restored key.
		const restored = await t.run(async (ctx) => {
			const row = await ctx.db
				.query('keyVault')
				.withIndex('by_address', (q) => q.eq('address', address))
				.first();
			return row!.sealedPrivateKey;
		});
		const restoredPrivateArmored = openPrivateKey(restored);
		const outcome = await openSealed({
			raw: sealedFixture,
			recipientPrivateKeysArmored: [restoredPrivateArmored],
		});
		expect(outcome.status).toBe('opened');
		if (outcome.status === 'opened') {
			expect(outcome.innerMime).toContain('the sealed body');
		}
	});

	it('importing an OLDER kit while a DIFFERENT key is active keeps BOTH keys decrypting', async () => {
		const t = convexTest(schema, modules);
		await enableSealedMail(t);
		const address = 'both@sealed.example.com';

		// Mint key A and seal a fixture to it, then export A's recovery kit.
		await t.action(internal.e2ee.keysNode.mintForAddress, { address });
		const publicA = (await t.query(api.e2ee.keys.getPublicKeyByAddress, { address }))!
			.publicKeyArmored;
		const sealedToA = (await openpgp.encrypt({
			message: await openpgp.createMessage({ text: 'sealed to key A' }),
			encryptionKeys: await openpgp.readKey({ armoredKey: publicA }),
			format: 'armored',
		})) as string;
		const kitA = await t.action(internal.e2ee.lifecycleNode.runExportRecoveryKit, { address });
		expect(kitA).not.toBeNull();

		// Rotate to key B (A retired to decrypt-only), and seal a fixture to B.
		await t.action(internal.e2ee.lifecycleNode.runRotateAddressKey, { address });
		const publicB = (await t.query(api.e2ee.keys.getPublicKeyByAddress, { address }))!
			.publicKeyArmored;
		const sealedToB = (await openpgp.encrypt({
			message: await openpgp.createMessage({ text: 'sealed to key B' }),
			encryptionKeys: await openpgp.readKey({ armoredKey: publicB }),
			format: 'armored',
		})) as string;

		// Import the OLDER kit A while B is active. The active key's private material
		// must NOT be clobbered (the storeKeypair bug this guards against).
		const imported = await t.action(internal.e2ee.lifecycleNode.runImportRecoveryKit, {
			address,
			privateKeyArmored: kitA!.privateKeyArmored,
		});
		expect(imported.imported).toBe(true);
		const publicAfterImport = await t.query(api.e2ee.keys.getPublicKeyByAddress, { address });
		expect(publicAfterImport?.publicKeyArmored).toBe(publicB);

		// B remains published, while BOTH private keys are present and BOTH fixtures open.
		const sealedKeys = await t.query(internal.e2ee.keys.getAddressPrivateKeysInternal, { address });
		const recipientPrivateKeysArmored = sealedKeys.map((env) => openPrivateKey(env));
		expect(recipientPrivateKeysArmored.length).toBeGreaterThanOrEqual(2);

		const outcomeA = await openSealed({ raw: sealedToA, recipientPrivateKeysArmored });
		expect(outcomeA.status).toBe('opened');
		if (outcomeA.status === 'opened') expect(outcomeA.innerMime).toContain('sealed to key A');

		const outcomeB = await openSealed({ raw: sealedToB, recipientPrivateKeysArmored });
		expect(outcomeB.status).toBe('opened');
		if (outcomeB.status === 'opened') expect(outcomeB.innerMime).toContain('sealed to key B');
	});

	it('rejects an import whose key does not certify the address', async () => {
		const t = convexTest(schema, modules);
		// A key for a DIFFERENT address must not be sealed in as this address's key.
		const { privateKey } = await openpgp.generateKey({
			type: 'curve25519',
			userIDs: [{ name: 'someone', email: 'someone@else.example.com' }],
			format: 'armored',
		});
		const result = await t.action(internal.e2ee.lifecycleNode.runImportRecoveryKit, {
			address: 'victim@sealed.example.com',
			privateKeyArmored: privateKey,
		});
		expect(result.imported).toBe(false);
	});
});
