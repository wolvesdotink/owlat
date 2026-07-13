/**
 * Sealed Mail INSTANCE_SECRET re-seal migration — hard gate (E6, part c).
 *
 *   1. PURE: with INSTANCE_SECRET rotated (current = new, previous = old), a
 *      private key still sealed under the OLD secret OPENS via the fallback, and
 *      `reSealPrivateKey` re-seals it under the NEW secret.
 *   2. A MIXED-VERSION vault (some rows still on the old secret, some already on
 *      the new one) READS CORRECTLY mid-migration; `runReSealVault` migrates
 *      every row so the vault opens under the new secret ALONE afterwards.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, afterEach } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import { createSecretBox, type SecretBoxEnvelope } from '../../lib/credentialCrypto';
import { openPrivateKey, reSealPrivateKey, sealPrivateKey } from '../sealing';

const rootGlob = import.meta.glob('../../**/*.*s');
const e2eeGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../e2ee/'),
		mod,
	])
);
const modules = { ...rootGlob, ...e2eeGlob };

const E2EE_KEY_BOX = { salt: 'owlat:e2ee:keys:salt:v1', info: 'owlat:e2ee:keys:v1' };
const SECRET_OLD = 'instance-secret-generation-1';
const SECRET_NEW = 'instance-secret-generation-2';

function sealWith(secret: string, plaintext: string): SecretBoxEnvelope {
	return createSecretBox(secret, E2EE_KEY_BOX).seal(plaintext);
}

async function seedKeyRow(
	t: ReturnType<typeof convexTest>,
	address: string,
	sealedPrivateKey: SecretBoxEnvelope
): Promise<void> {
	const now = Date.now();
	await t.run(async (ctx) => {
		await ctx.db.insert('keyVault', {
			kind: 'address',
			address,
			domain: address.split('@')[1] as string,
			wkdHash: 'hash',
			fingerprint: address.toUpperCase(),
			algorithm: 'eddsaLegacy',
			publicKeyArmored: 'PUB',
			publicKeyBinaryBase64: 'AAAA',
			sealedPrivateKey,
			isActive: true,
			createdAt: now,
			updatedAt: now,
		});
	});
}

describe('e2ee/sealing INSTANCE_SECRET rotation', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('opens a key sealed under the previous secret, then re-seals under the new one', () => {
		const envelopeUnderOld = sealWith(SECRET_OLD, 'PRIVATE-KEY-MATERIAL');

		// Rotation window: current = new, previous = old.
		vi.stubEnv('INSTANCE_SECRET', SECRET_NEW);
		vi.stubEnv('INSTANCE_SECRET_PREVIOUS', SECRET_OLD);

		// The fallback opens a row still on the old secret...
		expect(openPrivateKey(envelopeUnderOld)).toBe('PRIVATE-KEY-MATERIAL');
		// ...and a row already on the new secret opens directly.
		expect(openPrivateKey(sealPrivateKey('NEW-ROW'))).toBe('NEW-ROW');

		// Re-seal the old-secret row under the new secret.
		const reSealed = reSealPrivateKey(envelopeUnderOld);

		// After the window closes (no previous), the re-sealed row still opens...
		vi.stubEnv('INSTANCE_SECRET', SECRET_NEW);
		vi.stubEnv('INSTANCE_SECRET_PREVIOUS', '');
		expect(openPrivateKey(reSealed)).toBe('PRIVATE-KEY-MATERIAL');
		// ...but the ORIGINAL old-secret envelope no longer opens (auth-tag mismatch).
		expect(() => openPrivateKey(envelopeUnderOld)).toThrow();
	});

	it('migrates a mixed-version vault so it reads under the new secret alone', async () => {
		const t = convexTest(schema, modules);

		// A vault where one row is still on the OLD secret and one is already on the NEW.
		await seedKeyRow(t, 'old@sealed.example.com', sealWith(SECRET_OLD, 'OLD-ROW-KEY'));
		await seedKeyRow(t, 'new@sealed.example.com', sealWith(SECRET_NEW, 'NEW-ROW-KEY'));

		vi.stubEnv('INSTANCE_SECRET', SECRET_NEW);
		vi.stubEnv('INSTANCE_SECRET_PREVIOUS', SECRET_OLD);

		// MID-MIGRATION: both rows read correctly right now (fallback bridges the old row).
		const midValues = await t.run(async (ctx) => {
			const rows = await ctx.db.query('keyVault').collect();
			return rows
				.sort((a, b) => a.address!.localeCompare(b.address!))
				.map((r) => openPrivateKey(r.sealedPrivateKey));
		});
		expect(midValues).toEqual(['OLD-ROW-KEY', 'NEW-ROW-KEY']);

		// Run the migration.
		const result = await t.action(internal.e2ee.lifecycleNode.runReSealVault, {});
		expect(result.reSealed).toBe(2);
		expect(result.failed).toBe(0);

		// The rotation window is now closed — every row opens under the NEW secret alone.
		vi.stubEnv('INSTANCE_SECRET', SECRET_NEW);
		vi.stubEnv('INSTANCE_SECRET_PREVIOUS', '');
		const finalValues = await t.run(async (ctx) => {
			const rows = await ctx.db.query('keyVault').collect();
			return rows
				.sort((a, b) => a.address!.localeCompare(b.address!))
				.map((r) => openPrivateKey(r.sealedPrivateKey));
		});
		expect(finalValues).toEqual(['OLD-ROW-KEY', 'NEW-ROW-KEY']);
	});
});
