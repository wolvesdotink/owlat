'use node';

/**
 * Key lifecycle — the Node (`'use node'`) plane of Sealed Mail key rotation,
 * revocation, INSTANCE_SECRET re-sealing, and the recovery kit (plan 2026-07-11,
 * E6; locked decision D7: recovery kit only, NO admin escrow).
 *
 * These need `openpgp` (keygen, statement signing, key parsing) and the Node
 * secret box (`e2ee/sealing.ts`), so they live here; all DB work is delegated to
 * the v8 sibling `e2ee/lifecycle.ts` / `e2ee/keys.ts`.
 *
 * Actions:
 *   - `runRotateAddressKey` — mint a new address key, sign a rotation statement
 *     with the OLD key (so peers pinned to the old key upgrade silently), and
 *     store it (old key retired to decrypt-only);
 *   - `runReSealVault` — re-seal every vault private key under the current
 *     INSTANCE_SECRET (the versioned re-seal migration);
 *   - `exportRecoveryKit` (admin) — the ONLY sanctioned private-key egress: the
 *     armored private key + plain-language instructions for one address;
 *   - `importRecoveryKit` (admin) — restore an address key from a recovery kit.
 */

import { v } from 'convex/values';
import * as openpgp from 'openpgp';
import { internalAction, type ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import { authedAction } from '../lib/authedFunctions';
import { normalizeEmail } from '@owlat/shared';
import { armoredToBinaryBase64, splitAddress, wkdHashForAddress } from './wkd';
import { openPrivateKey, reSealPrivateKey, sealPrivateKey } from './sealing';
import { rotationStatementText } from './pinning';
import { keyCertifiesAddress } from './discovery';
import { generateKeypair, KEY_ALGORITHM } from './keysNode';
import { buildRecoveryKit, type RecoveryKit } from './recoveryKit';

/**
 * Sign a rotation statement (old -> new) with the OLD armored private key,
 * producing an armored detached signature over the canonical statement bytes.
 */
async function signRotationStatement(
	oldPrivateKeyArmored: string,
	statement: { address: string; oldFingerprint: string; newFingerprint: string }
): Promise<string> {
	const privateKey = await openpgp.readPrivateKey({ armoredKey: oldPrivateKeyArmored });
	return openpgp.sign({
		message: await openpgp.createMessage({ text: rotationStatementText(statement) }),
		signingKeys: privateKey,
		detached: true,
		format: 'armored',
	});
}

/**
 * Rotate one address's Sealed Mail key. Loads the current active key, mints a
 * fresh keypair, signs an old->new rotation statement with the OLD private key,
 * and stores the rotation atomically (old key retired to decrypt-only, new key
 * active, statement published to the manifest feed). A no-op when the address has
 * no active key to rotate FROM.
 */
export const runRotateAddressKey = internalAction({
	args: { address: v.string() },
	returns: v.object({
		rotated: v.boolean(),
		oldFingerprint: v.optional(v.string()),
		newFingerprint: v.optional(v.string()),
	}),
	handler: async (
		ctx,
		args
	): Promise<{ rotated: boolean; oldFingerprint?: string; newFingerprint?: string }> => {
		const { localPart, domain } = splitAddress(args.address);
		const address = `${localPart}@${domain}`;

		const current = await ctx.runQuery(internal.e2ee.keys.getAddressKeyInternal, { address });
		if (!current) return { rotated: false };

		let oldPrivateKeyArmored: string;
		try {
			oldPrivateKeyArmored = openPrivateKey(current.sealedPrivateKey);
		} catch {
			// The old key can't be opened (e.g. its secret is gone) — refuse rather
			// than mint a new key with no verifiable rotation statement.
			return { rotated: false };
		}

		const fresh = await generateKeypair(address, address);
		const statement = {
			address,
			oldFingerprint: current.fingerprint,
			newFingerprint: fresh.fingerprint,
		};
		const rotationSignature = await signRotationStatement(oldPrivateKeyArmored, statement);

		const stored = await ctx.runMutation(internal.e2ee.lifecycle.storeRotatedAddressKey, {
			address,
			domain,
			wkdHash: wkdHashForAddress(address),
			oldFingerprint: current.fingerprint,
			newFingerprint: fresh.fingerprint,
			algorithm: KEY_ALGORITHM,
			publicKeyArmored: fresh.publicKeyArmored,
			publicKeyBinaryBase64: fresh.publicKeyBinaryBase64,
			sealedPrivateKey: sealPrivateKey(fresh.privateKeyArmored),
			rotationSignature,
		});
		if (!stored.rotated) return { rotated: false };
		return {
			rotated: true,
			oldFingerprint: current.fingerprint,
			newFingerprint: fresh.fingerprint,
		};
	},
});

/**
 * Re-seal every vault private key under the CURRENT INSTANCE_SECRET (the
 * versioned re-seal migration). Each row is opened rotation-aware (accepting a
 * row still sealed under INSTANCE_SECRET_PREVIOUS) and re-sealed under the
 * current secret, so the vault reads correctly throughout. Idempotent.
 */
export const runReSealVault = internalAction({
	args: {},
	returns: v.object({ reSealed: v.number(), failed: v.number() }),
	handler: async (ctx): Promise<{ reSealed: number; failed: number }> => {
		const rows = await ctx.runQuery(internal.e2ee.lifecycle.listVaultForReseal, {});
		let reSealed = 0;
		let failed = 0;
		for (const row of rows) {
			try {
				const reSealedEnvelope = reSealPrivateKey(row.sealedPrivateKey);
				await ctx.runMutation(internal.e2ee.lifecycle.updateSealedPrivateKey, {
					id: row.id,
					sealedPrivateKey: reSealedEnvelope,
				});
				reSealed++;
			} catch {
				// A row that opens under NEITHER the current nor the previous secret is
				// left as-is (its data is unrecoverable via re-seal) and counted, so the
				// migration reports honestly rather than throwing halfway through.
				failed++;
			}
		}
		return { reSealed, failed };
	},
});

/** Admin floor for a `'use node'` action — actions can't run requireOrgPermission themselves. */
async function assertAdmin(ctx: ActionCtx): Promise<void> {
	await ctx.runQuery(internal.auth.membership.assertOrgAdmin, {});
}

/** Feature floor for a `'use node'` action — the flag is read via an internalQuery. */
async function assertSealedMailEnabled(ctx: ActionCtx): Promise<void> {
	if (!(await ctx.runQuery(internal.e2ee.keys.isSealedMailEnabled, {}))) {
		throw new Error('Sealed Mail is not enabled for this workspace.');
	}
}

/** The recovery-kit egress shape — the ONE place a private key leaves the vault. */
const recoveryKitValidator = v.union(
	v.null(),
	v.object({
		address: v.string(),
		fingerprint: v.string(),
		privateKeyArmored: v.string(),
		instructions: v.string(),
		filename: v.string(),
		generatedAt: v.number(),
	})
);

/**
 * The recovery-kit EXPORT core (no auth) — read the address's active key and
 * assemble its kit. Hoisted out of the handler (like `discovery.ts`) so both the
 * admin-gated public action and the internal action share ONE implementation
 * without a same-module `internal` self-reference. Returns null when the address
 * has no active key.
 */
async function exportRecoveryKitCore(ctx: ActionCtx, address: string): Promise<RecoveryKit | null> {
	const normalized = normalizeEmail(address);
	const row = await ctx.runQuery(internal.e2ee.keys.getAddressKeyInternal, { address: normalized });
	if (!row) return null;
	const privateKeyArmored = openPrivateKey(row.sealedPrivateKey);
	return buildRecoveryKit({
		address: normalized,
		fingerprint: row.fingerprint,
		privateKeyArmored,
		generatedAt: Date.now(),
	});
}

/**
 * The recovery-kit IMPORT core (no auth) — validate the armored private key
 * actually certifies the address, then seal + upsert it as the active key.
 * Rejects a key that does not bind the address (never seal a mismatched key in).
 */
async function importRecoveryKitCore(
	ctx: ActionCtx,
	address: string,
	privateKeyArmored: string
): Promise<{ imported: boolean; fingerprint?: string }> {
	const { localPart, domain } = splitAddress(address);
	const normalized = `${localPart}@${domain}`;

	let privateKey: Awaited<ReturnType<typeof openpgp.readPrivateKey>>;
	try {
		privateKey = await openpgp.readPrivateKey({ armoredKey: privateKeyArmored });
	} catch {
		return { imported: false };
	}
	const publicKeyArmored = privateKey.toPublic().armor();
	if (!(await keyCertifiesAddress(publicKeyArmored, normalized))) {
		return { imported: false };
	}

	const fingerprint = privateKey.getFingerprint().toUpperCase();
	// storeImportedAddressKey (NOT storeKeypair): a different imported fingerprint
	// is retained for decryption without replacing the currently published key.
	await ctx.runMutation(internal.e2ee.keys.storeImportedAddressKey, {
		address: normalized,
		domain,
		wkdHash: wkdHashForAddress(normalized),
		fingerprint,
		algorithm: KEY_ALGORITHM,
		publicKeyArmored,
		publicKeyBinaryBase64: await armoredToBinaryBase64(publicKeyArmored),
		sealedPrivateKey: sealPrivateKey(privateKeyArmored),
	});
	return { imported: true, fingerprint };
}

/**
 * Admin: build the RECOVERY KIT for an address — its armored private key plus
 * plain-language instructions. This is the ONLY sanctioned path a private key
 * ever leaves the vault in the clear (locked decision D7: no admin escrow, no
 * server-side plaintext copy). Returns null when the address has no active key.
 */
// authz: admin floor asserted at the top (assertOrgAdmin) — a `'use node'` action
// cannot run requireOrgPermission against ctx.db itself.
export const exportRecoveryKit = authedAction({
	args: { address: v.string() },
	returns: recoveryKitValidator,
	handler: async (ctx, args): Promise<RecoveryKit | null> => {
		await assertAdmin(ctx);
		// Feature-gate the private-key egress: with `sealedMail` OFF (the branch
		// default) there is no sealed mail to recover, so the export path stays shut.
		// (importRecoveryKit stays UNGATED on purpose — a restore must work on a
		// rebuilt instance before the flag is re-enabled.)
		await assertSealedMailEnabled(ctx);
		return exportRecoveryKitCore(ctx, args.address);
	},
});

/**
 * Admin: restore an address key from a recovery kit — the import path for a
 * rebuilt/restored instance.
 */
// authz: admin floor asserted at the top (assertOrgAdmin).
export const importRecoveryKit = authedAction({
	args: { address: v.string(), privateKeyArmored: v.string() },
	returns: v.object({ imported: v.boolean(), fingerprint: v.optional(v.string()) }),
	handler: async (ctx, args): Promise<{ imported: boolean; fingerprint?: string }> => {
		await assertAdmin(ctx);
		return importRecoveryKitCore(ctx, args.address, args.privateKeyArmored);
	},
});

/**
 * INTERNAL export core (no auth) — reachable only from other server functions /
 * tests, never a client. Shares {@link exportRecoveryKitCore} with the admin
 * action so the crypto is exercised without auth plumbing.
 */
export const runExportRecoveryKit = internalAction({
	args: { address: v.string() },
	handler: (ctx, args): Promise<RecoveryKit | null> => exportRecoveryKitCore(ctx, args.address),
});

/** INTERNAL import core (no auth) — see {@link runExportRecoveryKit}. */
export const runImportRecoveryKit = internalAction({
	args: { address: v.string(), privateKeyArmored: v.string() },
	returns: v.object({ imported: v.boolean(), fingerprint: v.optional(v.string()) }),
	handler: (ctx, args): Promise<{ imported: boolean; fingerprint?: string }> =>
		importRecoveryKitCore(ctx, args.address, args.privateKeyArmored),
});
