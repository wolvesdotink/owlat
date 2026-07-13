'use node';

/**
 * E2EE key vault — the Node (`'use node'`) plane: keygen + sealing.
 *
 * Mints Ed25519-primary / X25519-encryption-subkey OpenPGP keypairs (locked
 * decision D1) with `openpgp`, seals the private half at rest with the
 * domain-separated E2EE secret box (`createSecretBox(INSTANCE_SECRET,
 * owlat:e2ee:keys)`), and persists via the idempotent
 * `e2ee/keys.ts:storeKeypair` mutation. The V8 plane never sees a plaintext
 * private key; this plane never returns one.
 *
 * Actions:
 *   - `mintForAddress` — idempotently mint an address key (skips if present);
 *   - `ensureInstanceIdentity` — idempotently mint the instance signing key;
 *   - `runBackfill` — ensure the instance identity + a key for every address.
 */

import { v } from 'convex/values';
import * as openpgp from 'openpgp';
import { internalAction } from '../_generated/server';
import { internal } from '../_generated/api';
import { getOptional } from '../lib/env';
import { armoredToBinaryBase64, wkdHashForAddress, splitAddress } from './wkd';
import { sealPrivateKey } from './sealing';

interface GeneratedKeypair {
	fingerprint: string;
	publicKeyArmored: string;
	privateKeyArmored: string;
	publicKeyBinaryBase64: string;
}

/** Generate an Ed25519 + X25519 OpenPGP keypair bound to `email`. */
async function generateKeypair(email: string, name: string): Promise<GeneratedKeypair> {
	const { privateKey, publicKey } = await openpgp.generateKey({
		// `curve25519` yields an Ed25519 signing primary + an X25519 encryption
		// subkey — the RFC 9580 profile (locked decision D1). (The older
		// `type: 'ecc', curve: 'curve25519'` spelling is a deprecated alias that
		// openpgp v6's types reject even though the runtime still tolerates it.)
		type: 'curve25519',
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

		const kp = await generateKeypair(normalized, normalized);
		await ctx.runMutation(internal.e2ee.keys.storeKeypair, {
			kind: 'address',
			address: normalized,
			domain,
			wkdHash: wkdHashForAddress(normalized),
			fingerprint: kp.fingerprint,
			algorithm: 'ed25519',
			publicKeyArmored: kp.publicKeyArmored,
			publicKeyBinaryBase64: kp.publicKeyBinaryBase64,
			sealedPrivateKey: sealPrivateKey(kp.privateKeyArmored),
		});
		return { created: true, fingerprint: kp.fingerprint };
	},
});

/** Idempotently mint the singleton instance signing identity (minted at first backfill / boot). */
export const ensureInstanceIdentity = internalAction({
	args: {},
	returns: v.object({ created: v.boolean(), fingerprint: v.string() }),
	handler: async (ctx): Promise<{ created: boolean; fingerprint: string }> => {
		const existing = await ctx.runQuery(internal.e2ee.keys.getInstanceIdentityInternal, {});
		if (existing) return { created: false, fingerprint: existing.fingerprint };

		const email = instanceIdentityEmail();
		const kp = await generateKeypair(email, 'Owlat instance');
		await ctx.runMutation(internal.e2ee.keys.storeKeypair, {
			kind: 'instance',
			fingerprint: kp.fingerprint,
			algorithm: 'ed25519',
			publicKeyArmored: kp.publicKeyArmored,
			publicKeyBinaryBase64: kp.publicKeyBinaryBase64,
			sealedPrivateKey: sealPrivateKey(kp.privateKeyArmored),
		});
		return { created: true, fingerprint: kp.fingerprint };
	},
});

/**
 * Ensure the instance identity plus a key for every sendable address. Idempotent
 * — existing keys are left untouched. Triggered by `e2ee/keys.ts:backfillKeys`.
 */
export const runBackfill = internalAction({
	args: {},
	returns: v.object({ minted: v.number(), total: v.number() }),
	handler: async (ctx): Promise<{ minted: number; total: number }> => {
		await ctx.runAction(internal.e2ee.keysNode.ensureInstanceIdentity, {});
		const addresses = await ctx.runQuery(internal.e2ee.keys.listAddressesNeedingKeys, {});
		let minted = 0;
		for (const address of addresses) {
			const result = await ctx.runAction(internal.e2ee.keysNode.mintForAddress, { address });
			if (result.created) minted++;
		}
		return { minted, total: addresses.length };
	},
});
