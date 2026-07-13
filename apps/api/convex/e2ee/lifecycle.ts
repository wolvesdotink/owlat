/**
 * Key lifecycle — the V8 (query/mutation) plane of Sealed Mail key rotation,
 * revocation, and INSTANCE_SECRET re-sealing (plan 2026-07-11, E6).
 *
 * Keygen, signing, sealing and openpgp live in the `'use node'` sibling
 * `e2ee/lifecycleNode.ts`; this file owns the DB reads/writes:
 *   - `storeRotatedAddressKey` (internal) — the atomic rotation write: retire the
 *     old active key to DECRYPT-ONLY (mirrors DKIM overlap rotation), insert the
 *     new active key, and record the signed rotation statement for the manifest
 *     feed;
 *   - `deactivateAddressKeys` (internal) — revocation: flip every key for an
 *     address to inactive so it stops being published (decrypt-only rows are
 *     retained so historical sealed mail still opens);
 *   - `listRotationStatements` (internal) — the manifest's `keyRotations` feed;
 *   - `listVaultForReseal` / `updateSealedPrivateKey` (internal) — the
 *     INSTANCE_SECRET re-seal migration's read + per-row write;
 *   - `rotateAddressKey` / `revokeAddressKey` / `reSealVault` (admin) — the
 *     operator triggers, each scheduling the Node plane (flag-gated).
 *
 * Nothing here uses `authedIdentityMutation` (a locked Sealed-Mail rule).
 */

import { v } from 'convex/values';
import { internalMutation, internalQuery } from '../_generated/server';
import { internal } from '../_generated/api';
import { adminMutation } from '../lib/authedFunctions';
import { assertFeatureEnabled } from '../lib/featureFlags';
import { sealedPrivateKeyValidator } from './keys';
import { normalizeEmail } from '@owlat/shared';

/**
 * Atomically rotate an address to a freshly-minted key. The OLD active key is
 * flipped to `isActive: false` (kept as a DECRYPT-ONLY row so mail sealed to it
 * before the rotation still opens — the DKIM overlap-rotation pattern), the new
 * key is inserted active, and the OLD-key-signed rotation statement is recorded
 * in `keyRotations` for the manifest feed. Called only by the Node rotation
 * action, which has already minted + signed.
 */
export const storeRotatedAddressKey = internalMutation({
	args: {
		address: v.string(),
		domain: v.string(),
		wkdHash: v.string(),
		oldFingerprint: v.string(),
		newFingerprint: v.string(),
		algorithm: v.string(),
		publicKeyArmored: v.string(),
		publicKeyBinaryBase64: v.string(),
		sealedPrivateKey: sealedPrivateKeyValidator,
		rotationSignature: v.string(),
	},
	returns: v.union(
		v.object({ rotated: v.literal(false) }),
		v.object({ rotated: v.literal(true), newKeyId: v.id('keyVault'), retired: v.number() })
	),
	handler: async (ctx, args) => {
		const address = normalizeEmail(args.address);
		const now = Date.now();

		// Retire every currently-active key for the address to decrypt-only.
		const rows = await ctx.db
			.query('keyVault')
			.withIndex('by_address', (q) => q.eq('address', address))
			.collect(); // bounded: active key + a handful of retired keys.
		const activeRows = rows.filter((row) => row.isActive);
		if (
			activeRows.length !== 1 ||
			activeRows[0]?.fingerprint.toUpperCase() !== args.oldFingerprint.toUpperCase()
		) {
			return { rotated: false as const };
		}
		await ctx.db.patch(activeRows[0]._id, { isActive: false, updatedAt: now });

		// Insert the new active key.
		const newKeyId = await ctx.db.insert('keyVault', {
			kind: 'address',
			address,
			domain: args.domain.toLowerCase(),
			wkdHash: args.wkdHash,
			fingerprint: args.newFingerprint,
			algorithm: args.algorithm,
			publicKeyArmored: args.publicKeyArmored,
			publicKeyBinaryBase64: args.publicKeyBinaryBase64,
			sealedPrivateKey: args.sealedPrivateKey,
			isActive: true,
			createdAt: now,
			updatedAt: now,
		});

		// Record the signed rotation statement for the manifest rotation feed.
		await ctx.db.insert('keyRotations', {
			address,
			oldFingerprint: args.oldFingerprint.toUpperCase(),
			newFingerprint: args.newFingerprint.toUpperCase(),
			signature: args.rotationSignature,
			createdAt: now,
		});

		return { rotated: true as const, newKeyId, retired: 1 };
	},
});

/**
 * Revoke an address's key by deactivating EVERY row for it (revocation on
 * address deletion). Once inactive the public key stops being published over WKD
 * / the manifest directory and can no longer be sealed to; the rows themselves
 * are retained (decrypt-only) so any historical sealed mail can still be opened.
 * Idempotent. Internal — called by the Node revoke action / the address-deletion
 * hook.
 */
export const deactivateAddressKeys = internalMutation({
	args: { address: v.string() },
	returns: v.object({ deactivated: v.number() }),
	handler: async (ctx, args) => {
		const address = normalizeEmail(args.address);
		const rows = await ctx.db
			.query('keyVault')
			.withIndex('by_address', (q) => q.eq('address', address))
			.collect(); // bounded: active + a handful of retired rows for one address.
		let deactivated = 0;
		const now = Date.now();
		for (const row of rows) {
			if (row.isActive) {
				await ctx.db.patch(row._id, { isActive: false, updatedAt: now });
				deactivated++;
			}
		}
		return { deactivated };
	},
});

/**
 * The published rotation statements, newest first, for the manifest's
 * `keyRotations` feed. Bounded — a peer only needs the recent rotations to
 * bridge from a stale pin — so this returns at most `limit` (default 100).
 * Internal — read by the manifest signing action.
 */
export const listRotationStatements = internalQuery({
	args: { limit: v.optional(v.number()) },
	returns: v.array(
		v.object({
			address: v.string(),
			oldFingerprint: v.string(),
			newFingerprint: v.string(),
			signature: v.string(),
		})
	),
	handler: async (ctx, args) => {
		const limit = Math.max(1, Math.min(args.limit ?? 100, 500));
		const rows = await ctx.db
			.query('keyRotations')
			.withIndex('by_createdAt')
			.order('desc')
			.take(limit);
		return rows.map((r) => ({
			address: r.address,
			oldFingerprint: r.oldFingerprint,
			newFingerprint: r.newFingerprint,
			signature: r.signature,
		}));
	},
});

/**
 * Every `keyVault` row's id + sealed private envelope — the read side of the
 * INSTANCE_SECRET re-seal migration. Internal — consumed only by the Node
 * `reSealVault` action, which opens each envelope (rotation-aware) and re-seals
 * it under the current secret. Carries the SEALED private half only.
 */
export const listVaultForReseal = internalQuery({
	args: {},
	returns: v.array(v.object({ id: v.id('keyVault'), sealedPrivateKey: sealedPrivateKeyValidator })),
	handler: async (ctx) => {
		const rows = await ctx.db.query('keyVault').collect(); // bounded: one row per address + retired keys + the instance identity.
		return rows.map((r) => ({ id: r._id, sealedPrivateKey: r.sealedPrivateKey }));
	},
});

/** Patch one `keyVault` row's sealed private envelope — the re-seal migration's per-row write. */
export const updateSealedPrivateKey = internalMutation({
	args: { id: v.id('keyVault'), sealedPrivateKey: sealedPrivateKeyValidator },
	handler: async (ctx, args) => {
		await ctx.db.patch(args.id, { sealedPrivateKey: args.sealedPrivateKey, updatedAt: Date.now() });
	},
});

/**
 * Admin: rotate an address's Sealed Mail key — mint a new key, publish a signed
 * rotation statement, and retire the old key to decrypt-only. Flag-gated behind
 * `sealedMail`; schedules the Node action which does keygen/sign/seal.
 */
export const rotateAddressKey = adminMutation({
	args: { address: v.string() },
	handler: async (ctx, args) => {
		await assertFeatureEnabled(ctx, 'sealedMail');
		await ctx.scheduler.runAfter(0, internal.e2ee.lifecycleNode.runRotateAddressKey, {
			address: normalizeEmail(args.address),
		});
		return { scheduled: true as const };
	},
});

/**
 * Admin: revoke an address's key (e.g. on address deletion) — stop publishing it
 * for sealing while keeping decrypt-only access to historical mail. Flag-gated.
 */
export const revokeAddressKey = adminMutation({
	args: { address: v.string() },
	handler: async (ctx, args): Promise<{ deactivated: number }> => {
		await assertFeatureEnabled(ctx, 'sealedMail');
		return ctx.runMutation(internal.e2ee.lifecycle.deactivateAddressKeys, {
			address: normalizeEmail(args.address),
		});
	},
});

/**
 * Admin: re-seal every vault private key under the CURRENT `INSTANCE_SECRET`
 * (run after rotating the secret, with the prior value in
 * `INSTANCE_SECRET_PREVIOUS`). Flag-gated; schedules the Node migration.
 */
export const reSealVault = adminMutation({
	args: {},
	handler: async (ctx) => {
		await assertFeatureEnabled(ctx, 'sealedMail');
		await ctx.scheduler.runAfter(0, internal.e2ee.lifecycleNode.runReSealVault, {});
		return { scheduled: true as const };
	},
});
