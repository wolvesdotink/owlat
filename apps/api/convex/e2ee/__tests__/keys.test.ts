/**
 * E2EE key vault — the hard test gate for the E1 key-vault piece:
 *   1. IDEMPOTENT MINT — minting the same address twice yields one row and the
 *      second call reports `created:false` (no regeneration).
 *   2. ENVELOPE ROUND-TRIP — the sealed private key opens under the E2EE secret
 *      box back to a real OpenPGP private key whose fingerprint matches the row.
 *   3. AUTHZ NEGATIVE — no PUBLIC query path ever returns private key material;
 *      the sealed private key is reachable only via the internal/DB plane.
 *   4. BACKFILL — the idempotent backfill mints a key for every mailbox address
 *      AND every alias, plus the singleton instance identity.
 *
 * Keygen + sealing run in the Node action plane, so INSTANCE_SECRET is stubbed.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as openpgp from 'openpgp';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import { createSecretBox } from '../../lib/credentialCrypto';

const rootGlob = import.meta.glob('../../**/*.*s');
const e2eeGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../e2ee/'),
		mod,
	])
);
const modules = { ...rootGlob, ...e2eeGlob };

const E2EE_KEY_BOX = { salt: 'owlat:e2ee:keys:salt:v1', info: 'owlat:e2ee:keys:v1' };

async function insertMailbox(t: ReturnType<typeof convexTest>, address: string): Promise<void> {
	const now = Date.now();
	await t.run(async (ctx) => {
		await ctx.db.insert('mailboxes', {
			userId: 'user-1',
			organizationId: 'org-1',
			address,
			domain: address.split('@')[1] as string,
			status: 'active',
			usedBytes: 0,
			uidValidity: now,
			createdAt: now,
			updatedAt: now,
		});
	});
}

describe('e2ee/keys', () => {
	beforeEach(() => {
		vi.stubEnv('INSTANCE_SECRET', 'unit-test-instance-secret-value');
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('mints an address key idempotently (one row, second call created:false)', async () => {
		const t = convexTest(schema, modules);
		const address = 'alice@sealed.example.com';

		const first = await t.action(internal.e2ee.keysNode.mintForAddress, { address });
		expect(first.created).toBe(true);
		expect(first.fingerprint).toMatch(/^[0-9A-F]{40}$/);

		const second = await t.action(internal.e2ee.keysNode.mintForAddress, { address });
		expect(second.created).toBe(false);
		expect(second.fingerprint).toBe(first.fingerprint);

		const rows = await t.run((ctx) =>
			ctx.db
				.query('keyVault')
				.withIndex('by_address', (q) => q.eq('address', address))
				.collect()
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.wkdHash).toBe('kei1q4tipxxu1yj79k9kfukdhfy631xe'); // WKD hash of "alice"
	});

	it('seals the private key so it opens back to a matching OpenPGP key', async () => {
		const t = convexTest(schema, modules);
		const address = 'bob@sealed.example.org';
		const { fingerprint } = await t.action(internal.e2ee.keysNode.mintForAddress, { address });

		const row = await t.run((ctx) =>
			ctx.db
				.query('keyVault')
				.withIndex('by_address', (q) => q.eq('address', address))
				.first()
		);
		expect(row).not.toBeNull();

		const box = createSecretBox('unit-test-instance-secret-value', E2EE_KEY_BOX);
		const privateKeyArmored = box.open(row!.sealedPrivateKey);
		const privateKey = await openpgp.readPrivateKey({ armoredKey: privateKeyArmored });
		expect(privateKey.getFingerprint().toUpperCase()).toBe(fingerprint);
	});

	it('never exposes private key material through any public query', async () => {
		const t = convexTest(schema, modules);
		const address = 'carol@sealed.example.com';
		await t.action(internal.e2ee.keysNode.mintForAddress, { address });

		const pub = await t.query(api.e2ee.keys.getPublicKeyByAddress, { address });
		expect(pub).not.toBeNull();
		expect(Object.keys(pub!).sort()).toEqual(['fingerprint', 'publicKeyArmored']);
		expect(JSON.stringify(pub)).not.toContain('PRIVATE KEY');

		const wkd = await t.query(api.e2ee.keys.getKeyForWkd, {
			domain: 'sealed.example.com',
			wkdHash: 'fnh1sizqc1h17q515b19nhzxyddotzhd', // WKD hash of "carol"
		});
		// WKD returns the PUBLIC key body — present, and never a private packet.
		expect(wkd).not.toBeNull();
		const body = Buffer.from(wkd!.binaryBase64, 'base64');
		expect(new TextDecoder().decode(body)).not.toContain('PRIVATE');

		// The sealed private key DOES exist — just not on any public surface.
		const row = await t.run((ctx) =>
			ctx.db
				.query('keyVault')
				.withIndex('by_address', (q) => q.eq('address', address))
				.first()
		);
		expect(row?.sealedPrivateKey.ciphertext).toBeTruthy();
	});

	it('never exposes private material through the instance-key or manifest surfaces', async () => {
		const t = convexTest(schema, modules);
		// Publication follows the flag, so enable Sealed Mail for the manifest path.
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				featureFlags: { sealedMail: true },
				createdAt: Date.now(),
			});
		});
		await insertMailbox(t, 'primary@sealed.example.com');
		await t.action(internal.e2ee.keysNode.runBackfill, {});

		// getInstancePublicKey — PUBLIC signing-key discovery, public material only.
		const instance = await t.query(api.e2ee.keys.getInstancePublicKey, {});
		expect(instance).not.toBeNull();
		expect(Object.keys(instance!).sort()).toEqual(['fingerprint', 'publicKeyArmored']);
		expect(JSON.stringify(instance)).not.toContain('PRIVATE');

		// getSignedManifest — PUBLIC action; carries the PUBLIC instance key + a
		// detached signature, never the private half.
		const manifest = await t.action(api.e2ee.manifest.getSignedManifest, {});
		expect(manifest).not.toBeNull();
		expect(JSON.stringify(manifest)).not.toContain('PRIVATE');
		expect(manifest!.instance.publicKeyArmored).toContain('PUBLIC KEY');
		expect(manifest!.signature).toContain('PGP SIGNATURE');
	});

	it('stops publishing the manifest when Sealed Mail is turned OFF', async () => {
		const t = convexTest(schema, modules);
		await insertMailbox(t, 'primary@sealed.example.com');
		await t.action(internal.e2ee.keysNode.runBackfill, {});
		// Flag defaults OFF (no instanceSettings row) — publication must 404.
		expect(await t.action(api.e2ee.manifest.getSignedManifest, {})).toBeNull();
	});

	it('backfills a key for every mailbox address AND alias, plus the instance identity', async () => {
		const t = convexTest(schema, modules);
		await insertMailbox(t, 'primary@sealed.example.com');
		await insertMailbox(t, 'team@sealed.example.com');

		// An alias targeting the first mailbox.
		const now = Date.now();
		await t.run(async (ctx) => {
			const mailbox = await ctx.db
				.query('mailboxes')
				.withIndex('by_address', (q) => q.eq('address', 'primary@sealed.example.com'))
				.first();
			await ctx.db.insert('mailAliases', {
				alias: 'sales@sealed.example.com',
				targetMailboxId: mailbox!._id,
				organizationId: 'org-1',
				createdAt: now,
			});
		});

		const result = await t.action(internal.e2ee.keysNode.runBackfill, {});
		expect(result.total).toBe(3);
		expect(result.minted).toBe(3);

		const addressRows = await t.run((ctx) =>
			ctx.db
				.query('keyVault')
				.withIndex('by_kind', (q) => q.eq('kind', 'address'))
				.collect()
		);
		expect(addressRows.map((r) => r.address).sort()).toEqual([
			'primary@sealed.example.com',
			'sales@sealed.example.com',
			'team@sealed.example.com',
		]);

		const instance = await t.query(api.e2ee.keys.getInstancePublicKey, {});
		expect(instance?.publicKeyArmored).toContain('PUBLIC KEY');

		// Re-running is idempotent: nothing new is minted.
		const again = await t.action(internal.e2ee.keysNode.runBackfill, {});
		expect(again.minted).toBe(0);
	});
});
