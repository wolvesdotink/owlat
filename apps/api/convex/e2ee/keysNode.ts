'use node';

/**
 * E2EE key vault — the Node (`'use node'`) plane: keygen + sealing.
 *
 * Mints OpenPGP keypairs on the GnuPG-compatible LEGACY curve25519 profile
 * (EdDSA-legacy signing primary + ECDH encryption subkey, both on Curve25519 —
 * OpenPGP algorithm IDs 22/18) with `openpgp`, seals the private half at rest
 * with the domain-separated E2EE secret box (`createSecretBox(INSTANCE_SECRET,
 * owlat:e2ee:keys)`), and persists via the idempotent
 * `e2ee/keys.ts:storeKeypair` mutation. The V8 plane never sees a plaintext
 * private key; this plane never returns one.
 *
 * The legacy profile (what Proton mints) is required for interop: GnuPG 2.5.x,
 * Thunderbird/RNP and older gpg all REJECT the RFC 9580 new-style ed25519/x25519
 * algorithm IDs (25/27) — so encrypting TO an Owlat-published WKD key would fail.
 * The on-the-wire message/signature format is unchanged (locked decision D1);
 * only the KEY algorithm-ID profile differs.
 *
 * Actions:
 *   - `mintForAddress` — idempotently mint an address key (skips if present);
 *   - `ensureInstanceIdentity` — idempotently mint the instance signing key;
 *   - `remintLegacyProfile` — re-mint any old new-style key onto the legacy
 *     profile (idempotent: already-legacy keys are skipped);
 *   - `runBackfill` — re-mint stale-profile keys, then ensure the instance
 *     identity + a key for every address.
 */

import { v } from 'convex/values';
import * as openpgp from 'openpgp';
import { internalAction, type ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import { getOptional } from '../lib/env';
import { armoredToBinaryBase64, wkdHashForAddress, splitAddress } from './wkd';
import { sealPrivateKey } from './sealing';

export interface GeneratedKeypair {
	fingerprint: string;
	publicKeyArmored: string;
	privateKeyArmored: string;
	publicKeyBinaryBase64: string;
}

/**
 * Algorithm label stored on the `keyVault` row (metadata only — no logic keys
 * off it). `eddsaLegacy` names the GnuPG-compatible signing primary. Shared with
 * the E6 lifecycle plane so a rotated key carries the same label.
 */
export const KEY_ALGORITHM = 'eddsaLegacy';

/**
 * Generate a GnuPG-compatible OpenPGP keypair (EdDSA-legacy signing primary +
 * ECDH encryption subkey, both Curve25519) bound to `email`. Exported so the E6
 * key-lifecycle plane (`e2ee/lifecycleNode.ts`) mints rotated keys on the exact
 * same profile.
 */
export async function generateKeypair(email: string, name: string): Promise<GeneratedKeypair> {
	const { privateKey, publicKey } = await openpgp.generateKey({
		// `type: 'ecc', curve: 'curve25519Legacy'` yields an EdDSA-legacy signing
		// primary (algo 22) + an ECDH encryption subkey (algo 18), both on
		// Curve25519 — the LEGACY profile every OpenPGP implementation accepts and
		// exactly what Proton mints. The RFC 9580 new-style `type: 'curve25519'`
		// profile (Ed25519=27 / X25519=25) is rejected by GnuPG 2.5.x, Thunderbird
		// /RNP and older gpg, so a WKD/manifest key minted that way cannot be
		// encrypted TO. Only the key algorithm-ID profile changes here — the
		// message/signature format stays per locked decision D1.
		type: 'ecc',
		curve: 'curve25519Legacy',
		userIDs: [{ name, email }],
		format: 'armored',
	});
	const key = await openpgp.readKey({ armoredKey: publicKey });
	return {
		fingerprint: key.getFingerprint().toUpperCase(),
		publicKeyArmored: publicKey,
		privateKeyArmored: privateKey,
		publicKeyBinaryBase64: await armoredToBinaryBase64(publicKey),
	};
}

/**
 * Whether `publicKeyArmored` already uses the GnuPG-compatible legacy profile
 * (EdDSA-legacy primary + ECDH encryption subkey) rather than the RFC 9580
 * new-style ed25519/x25519 algorithm IDs. Drives the idempotent re-mint: a key
 * that is already legacy is left untouched.
 */
async function isLegacyProfile(publicKeyArmored: string): Promise<boolean> {
	const key = await openpgp.readKey({ armoredKey: publicKeyArmored });
	const primary = key.getAlgorithmInfo();
	const subkey = key.getSubkeys()[0]?.getAlgorithmInfo();
	return primary.algorithm === 'eddsaLegacy' && subkey?.algorithm === 'ecdh';
}

/** Derive the instance-identity email from SITE_URL's host (fallback `localhost`). */
function instanceIdentityEmail(): string {
	const siteUrl = getOptional('SITE_URL');
	let host = 'localhost';
	if (siteUrl) {
		try {
			host = new URL(siteUrl).host || host;
		} catch {
			// keep fallback
		}
	}
	return `instance@${host}`;
}

/**
 * Mint a fresh instance-identity keypair and upsert it (unconditionally — the
 * caller decides whether a key is missing or stale). Returns the fingerprint.
 */
async function mintAndStoreInstance(ctx: ActionCtx): Promise<string> {
	const kp = await generateKeypair(instanceIdentityEmail(), 'Owlat instance');
	await ctx.runMutation(internal.e2ee.keys.storeKeypair, {
		kind: 'instance',
		fingerprint: kp.fingerprint,
		algorithm: KEY_ALGORITHM,
		publicKeyArmored: kp.publicKeyArmored,
		publicKeyBinaryBase64: kp.publicKeyBinaryBase64,
		sealedPrivateKey: sealPrivateKey(kp.privateKeyArmored),
	});
	return kp.fingerprint;
}

/**
 * Mint a fresh address keypair for `address` and upsert it (unconditionally).
 * Refreshes the published WKD binary. Returns the fingerprint.
 */
async function mintAndStoreAddress(ctx: ActionCtx, address: string): Promise<string> {
	const { localPart, domain } = splitAddress(address);
	const normalized = `${localPart}@${domain}`;
	const kp = await generateKeypair(normalized, normalized);
	await ctx.runMutation(internal.e2ee.keys.storeKeypair, {
		kind: 'address',
		address: normalized,
		domain,
		wkdHash: wkdHashForAddress(normalized),
		fingerprint: kp.fingerprint,
		algorithm: KEY_ALGORITHM,
		publicKeyArmored: kp.publicKeyArmored,
		publicKeyBinaryBase64: kp.publicKeyBinaryBase64,
		sealedPrivateKey: sealPrivateKey(kp.privateKeyArmored),
	});
	return kp.fingerprint;
}

/**
 * Idempotently mint + publish an address key. Skips keygen entirely when an
 * active key already exists (so re-runs are cheap and stable).
 */
export const mintForAddress = internalAction({
	args: { address: v.string() },
	returns: v.object({ created: v.boolean(), fingerprint: v.string() }),
	handler: async (ctx, args): Promise<{ created: boolean; fingerprint: string }> => {
		const { localPart, domain } = splitAddress(args.address);
		const normalized = `${localPart}@${domain}`;

		const existing = await ctx.runQuery(internal.e2ee.keys.getAddressKeyInternal, {
			address: normalized,
		});
		if (existing) return { created: false, fingerprint: existing.fingerprint };

		const fingerprint = await mintAndStoreAddress(ctx, normalized);
		return { created: true, fingerprint };
	},
});

/** Idempotently mint the singleton instance signing identity (minted at first backfill / boot). */
export const ensureInstanceIdentity = internalAction({
	args: {},
	returns: v.object({ created: v.boolean(), fingerprint: v.string() }),
	handler: async (ctx): Promise<{ created: boolean; fingerprint: string }> => {
		const existing = await ctx.runQuery(internal.e2ee.keys.getInstanceIdentityInternal, {});
		if (existing) return { created: false, fingerprint: existing.fingerprint };

		const fingerprint = await mintAndStoreInstance(ctx);
		return { created: true, fingerprint };
	},
});

/**
 * Re-mint every `keyVault` entry that still carries an old RFC 9580 new-style
 * key onto the GnuPG-compatible legacy profile, in place, via `storeKeypair`
 * (which upserts by subject) — refreshing the published WKD binary at the same
 * time. Idempotent: rows already on the legacy profile are skipped, so a second
 * run re-mints nothing. The manifest key-directory digest changes as a natural
 * consequence (address fingerprints change), so `getSignedManifest` re-signs on
 * its next fetch.
 *
 * Safe re-mint (not decrypt-only retention): Sealed Mail has never shipped ON,
 * so no external TOFU pin of the old keys can exist and nothing was ever sealed
 * to them outside tests — the old key material is simply replaced.
 */
export const remintLegacyProfile = internalAction({
	args: {},
	returns: v.object({ reminted: v.number(), total: v.number() }),
	handler: async (ctx): Promise<{ reminted: number; total: number }> => {
		const entries = await ctx.runQuery(internal.e2ee.keys.listKeyProfiles, {});
		let reminted = 0;
		for (const entry of entries) {
			if (await isLegacyProfile(entry.publicKeyArmored)) continue; // already legacy — leave it

			if (entry.kind === 'instance') {
				await mintAndStoreInstance(ctx);
			} else if (entry.address) {
				await mintAndStoreAddress(ctx, entry.address);
			} else {
				continue; // address row without an address is unreachable — nothing to re-mint
			}
			reminted++;
		}
		return { reminted, total: entries.length };
	},
});

/**
 * Re-mint any stale-profile keys onto the legacy profile, then ensure the
 * instance identity plus a key for every sendable address. Idempotent — keys
 * already present on the legacy profile are left untouched. Triggered by
 * `e2ee/keys.ts:backfillKeys`.
 */
export const runBackfill = internalAction({
	args: {},
	returns: v.object({ reminted: v.number(), minted: v.number(), total: v.number() }),
	handler: async (ctx): Promise<{ reminted: number; minted: number; total: number }> => {
		const { reminted } = await ctx.runAction(internal.e2ee.keysNode.remintLegacyProfile, {});
		await ctx.runAction(internal.e2ee.keysNode.ensureInstanceIdentity, {});
		const addresses = await ctx.runQuery(internal.e2ee.keys.listAddressesNeedingKeys, {});
		let minted = 0;
		for (const address of addresses) {
			const result = await ctx.runAction(internal.e2ee.keysNode.mintForAddress, { address });
			if (result.created) minted++;
		}
		return { reminted, minted, total: addresses.length };
	},
});
