/**
 * E2EE key vault — the V8 (query/mutation) plane of Sealed Mail key management.
 *
 * Keygen and sealing live in the `'use node'` sibling `e2ee/keysNode.ts` (they
 * need `openpgp` + `node:crypto`); this file owns the DB reads/writes:
 *   - `storeKeypair` (internal) — idempotent upsert of a minted keypair;
 *   - PUBLIC discovery queries that return PUBLIC key material ONLY
 *     (`getPublicKeyByAddress`, `getKeyForWkd`, `getInstancePublicKey`);
 *   - INTERNAL reads that expose the sealed private envelope to the action
 *     plane only (`getAddressKeyInternal`, `getInstanceIdentityInternal`);
 *   - `getKeyDirectory` (internal) — the manifest's address->fingerprint map;
 *   - `listAddressesNeedingKeys` (internal) — the backfill worklist;
 *   - `backfillKeys` (admin) — the "publish encryption keys" trigger;
 *   - `getReadiness` (admin) — local publication status for delivery readiness.
 *
 * SECURITY INVARIANT (asserted in tests): NO public function returns
 * `sealedPrivateKey`. The private key is reachable only through `internalQuery`
 * results consumed inside the Node action plane.
 *
 * Nothing here uses `authedIdentityMutation` (a locked Sealed-Mail rule).
 */

import { v } from 'convex/values';
import { internalMutation, internalQuery, type QueryCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import { adminMutation, adminQuery, publicQuery } from '../lib/authedFunctions';
import { assertFeatureEnabled, isFeatureEnabled } from '../lib/featureFlags';
import { normalizeEmail } from '@owlat/shared';

/**
 * The ACTIVE `keyVault` row for a (normalized) address, or null. After a rotation
 * an address holds multiple rows — exactly one active, the rest decrypt-only — so
 * the by_address index is scanned for the active one rather than trusting
 * `.first()` (bounded: a handful of rows per address).
 */
async function activeAddressRow(ctx: QueryCtx, address: string): Promise<Doc<'keyVault'> | null> {
	const rows = await ctx.db
		.query('keyVault')
		.withIndex('by_address', (q) => q.eq('address', address))
		.collect(); // bounded: active + retired rows for one address.
	return rows.find((r) => r.isActive) ?? null;
}

/**
 * The at-rest sealed private-key envelope shape (a `credentialCrypto` secret box).
 * The single source of truth for this validator — `e2ee/lifecycle.ts` imports it
 * rather than re-declaring it, so the two planes can't drift.
 */
export const sealedPrivateKeyValidator = v.object({
	ciphertext: v.string(),
	iv: v.string(),
	authTag: v.string(),
});

/** Public projection of a keypair — PUBLIC material only, never the private half. */
const publicKeyProjectionValidator = v.union(
	v.null(),
	v.object({ fingerprint: v.string(), publicKeyArmored: v.string() })
);

/**
 * Idempotently persist a minted keypair. Called only by the Node action plane
 * after keygen + sealing. Upserts on the subject: the single `'instance'` row,
 * or the `'address'` row for `address`. A re-mint (same subject) replaces the
 * stored material in place rather than inserting a duplicate.
 */
export const storeKeypair = internalMutation({
	args: {
		kind: v.union(v.literal('instance'), v.literal('address')),
		address: v.optional(v.string()),
		domain: v.optional(v.string()),
		wkdHash: v.optional(v.string()),
		fingerprint: v.string(),
		algorithm: v.string(),
		publicKeyArmored: v.string(),
		publicKeyBinaryBase64: v.string(),
		sealedPrivateKey: sealedPrivateKeyValidator,
		// Intentional replacement (legacy-profile migration) must name the active
		// fingerprint it observed. Ordinary minting leaves this absent and can
		// never overwrite a concurrently-created identity.
		expectedFingerprint: v.optional(v.string()),
	},
	returns: v.object({ id: v.id('keyVault'), created: v.boolean(), fingerprint: v.string() }),
	handler: async (ctx, args) => {
		// An `'address'` row without an address is unreachable (no WKD hash, no
		// discovery) — reject it rather than silently inserting a dead row.
		if (args.kind === 'address' && !args.address) {
			throw new Error("storeKeypair: kind 'address' requires an address");
		}
		const now = Date.now();
		// Prefer the ACTIVE row for the subject. After a key rotation (E6) an address
		// has multiple rows — one active, the old ones decrypt-only — and `.first()`
		// on the by_address index would return whichever the index yields first
		// (often the OLDEST, inactive row). Selecting the active row keeps this an
		// upsert of the CURRENT key rather than reviving a retired one.
		const existing =
			args.kind === 'instance'
				? await ctx.db
						.query('keyVault')
						.withIndex('by_kind', (q) => q.eq('kind', 'instance'))
						.first()
				: args.address
					? await activeAddressRow(ctx, args.address)
					: null;

		if (existing) {
			const isSameKey = existing.fingerprint.toUpperCase() === args.fingerprint.toUpperCase();
			const mayReplace =
				args.expectedFingerprint !== undefined &&
				existing.fingerprint.toUpperCase() === args.expectedFingerprint.toUpperCase();
			if (!isSameKey && !mayReplace) {
				return {
					id: existing._id,
					created: false as const,
					fingerprint: existing.fingerprint,
				};
			}
			await ctx.db.patch(existing._id, {
				domain: args.domain,
				wkdHash: args.wkdHash,
				fingerprint: args.fingerprint,
				algorithm: args.algorithm,
				publicKeyArmored: args.publicKeyArmored,
				publicKeyBinaryBase64: args.publicKeyBinaryBase64,
				sealedPrivateKey: args.sealedPrivateKey,
				isActive: true,
				updatedAt: now,
			});
			return { id: existing._id, created: false as const, fingerprint: args.fingerprint };
		}
		if (args.expectedFingerprint !== undefined) {
			throw new Error('storeKeypair: active key changed before replacement');
		}

		const id = await ctx.db.insert('keyVault', {
			kind: args.kind,
			address: args.address,
			domain: args.domain,
			wkdHash: args.wkdHash,
			fingerprint: args.fingerprint,
			algorithm: args.algorithm,
			publicKeyArmored: args.publicKeyArmored,
			publicKeyBinaryBase64: args.publicKeyBinaryBase64,
			sealedPrivateKey: args.sealedPrivateKey,
			isActive: true,
			createdAt: now,
			updatedAt: now,
		});
		return { id, created: true as const, fingerprint: args.fingerprint };
	},
});

/**
 * Persist a RECOVERY-KIT-imported address key WITHOUT destroying any other key
 * held for the address. Unlike {@link storeKeypair} (which patches whichever row
 * is active — fine for a re-mint, fatal for an import), this NEVER overwrites a
 * row that carries a DIFFERENT fingerprint:
 *   - a row already holding the imported fingerprint is refreshed in place and
 *     made active (idempotent same-key re-import);
 *   - otherwise the imported key is INSERTED as a new active row and every other
 *     active row is retired to decrypt-only (the retire-then-insert shape of a
 *     rotation).
 * So importing an OLDER kit while a DIFFERENT key is active keeps BOTH private
 * keys — the current key's material is never clobbered and mail sealed to it
 * still opens. Internal — called only by the Node import action.
 */
export const storeImportedAddressKey = internalMutation({
	args: {
		address: v.string(),
		domain: v.optional(v.string()),
		wkdHash: v.optional(v.string()),
		fingerprint: v.string(),
		algorithm: v.string(),
		publicKeyArmored: v.string(),
		publicKeyBinaryBase64: v.string(),
		sealedPrivateKey: sealedPrivateKeyValidator,
	},
	returns: v.object({ id: v.id('keyVault'), created: v.boolean() }),
	handler: async (ctx, args) => {
		const address = normalizeEmail(args.address);
		const now = Date.now();
		const fingerprint = args.fingerprint.toUpperCase();
		const rows = await ctx.db
			.query('keyVault')
			.withIndex('by_address', (q) => q.eq('address', address))
			.collect(); // bounded: active key + a handful of retired keys.

		const material = {
			domain: args.domain,
			wkdHash: args.wkdHash,
			fingerprint: args.fingerprint,
			algorithm: args.algorithm,
			publicKeyArmored: args.publicKeyArmored,
			publicKeyBinaryBase64: args.publicKeyBinaryBase64,
			sealedPrivateKey: args.sealedPrivateKey,
		};

		const sameKey = rows.find((r) => r.fingerprint.toUpperCase() === fingerprint);
		if (sameKey) {
			// Re-importing a key we already hold: refresh + activate it, and retire any
			// OTHER active row so exactly one key stays active.
			for (const r of rows) {
				if (r._id !== sameKey._id && r.isActive) {
					await ctx.db.patch(r._id, { isActive: false, updatedAt: now });
				}
			}
			await ctx.db.patch(sameKey._id, { ...material, isActive: true, updatedAt: now });
			return { id: sameKey._id, created: false as const };
		}

		// A key we don't hold: retire every current active row to decrypt-only (never
		// overwrite its private material) and insert the import as the new active key.
		for (const r of rows) {
			if (r.isActive) await ctx.db.patch(r._id, { isActive: false, updatedAt: now });
		}
		const id = await ctx.db.insert('keyVault', {
			kind: 'address',
			address,
			...material,
			isActive: true,
			createdAt: now,
			updatedAt: now,
		});
		return { id, created: true as const };
	},
});

/**
 * The active address key row INCLUDING the sealed private envelope. Internal —
 * consumed only inside the Node action plane (seal/open, rotation). Never
 * exposed publicly.
 */
export const getAddressKeyInternal = internalQuery({
	args: { address: v.string() },
	handler: (ctx, args) => activeAddressRow(ctx, normalizeEmail(args.address)),
});

/**
 * EVERY sealed private-key envelope for an address — the ACTIVE key plus every
 * retired decrypt-only key kept from a rotation (E6). Newest first. Internal —
 * consumed only by the Node open plane (`e2ee/open.ts`), which decrypts an
 * inbound sealed message by TRYING every one of these keys, so a message sealed
 * to a now-rotated key still opens (the DKIM overlap-rotation property for
 * decryption). Never exposed publicly; carries the SEALED private half only.
 */
export const getAddressPrivateKeysInternal = internalQuery({
	args: { address: v.string() },
	returns: v.array(sealedPrivateKeyValidator),
	handler: async (ctx, args) => {
		const normalized = normalizeEmail(args.address);
		const rows = await ctx.db
			.query('keyVault')
			.withIndex('by_address', (q) => q.eq('address', normalized))
			.collect(); // bounded: active key + a handful of retired decrypt-only keys.
		// Active first, then most-recently-updated, so the common case (a message
		// sealed to the current key) is tried first.
		return rows
			.sort((a, b) => Number(b.isActive) - Number(a.isActive) || b.updatedAt - a.updatedAt)
			.map((r) => r.sealedPrivateKey);
	},
});

/**
 * Whether Sealed Mail is enabled — read from an action (which has no direct DB
 * access) to gate the public discovery/publication surfaces on the live flag.
 */
export const isSealedMailEnabled = internalQuery({
	args: {},
	returns: v.boolean(),
	handler: (ctx) => isFeatureEnabled(ctx, 'sealedMail'),
});

/**
 * Persist the signed manifest on the instance identity row so `getSignedManifest`
 * serves byte-stable bytes and re-signs only when the key-directory digest or the
 * instance key changes (avoids anonymous per-request OpenPGP signing). Internal —
 * written only by the manifest signing action.
 */
export const cacheInstanceManifest = internalMutation({
	args: {
		keyDirectoryDigest: v.string(),
		instanceFingerprint: v.string(),
		rotationFeedUrl: v.string(),
		signedManifestJson: v.string(),
	},
	handler: async (ctx, args) => {
		const row = await ctx.db
			.query('keyVault')
			.withIndex('by_kind', (q) => q.eq('kind', 'instance'))
			.first();
		if (!row) return;
		await ctx.db.patch(row._id, {
			cachedManifest: {
				keyDirectoryDigest: args.keyDirectoryDigest,
				instanceFingerprint: args.instanceFingerprint,
				rotationFeedUrl: args.rotationFeedUrl,
				signedManifestJson: args.signedManifestJson,
			},
			updatedAt: Date.now(),
		});
	},
});

/** The instance identity row (incl. sealed private key). Internal — action plane only. */
export const getInstanceIdentityInternal = internalQuery({
	args: {},
	handler: async (ctx) => {
		const row = await ctx.db
			.query('keyVault')
			.withIndex('by_kind', (q) => q.eq('kind', 'instance'))
			.first();
		return row && row.isActive ? row : null;
	},
});

/**
 * The address->fingerprint directory, used to compute the manifest's
 * key-directory digest. Internal — read by the manifest signing action.
 */
export const getKeyDirectory = internalQuery({
	args: {},
	handler: async (ctx) => {
		const rows = await ctx.db
			.query('keyVault')
			.withIndex('by_kind', (q) => q.eq('kind', 'address'))
			.collect(); // bounded: one row per Postbox address (mailboxes + aliases) — single-org instance.
		return rows.flatMap((r) =>
			r.isActive && r.address ? [{ address: r.address, fingerprint: r.fingerprint }] : []
		);
	},
});

/**
 * PUBLIC: the armored public key for an address, by design world-readable
 * (Sealed Mail key discovery — anyone may fetch anyone's public key). Returns
 * PUBLIC material only.
 */
export const getPublicKeyByAddress = publicQuery({
	// public: OpenPGP public-key discovery is intentionally unauthenticated (WKD/E2EE).
	args: { address: v.string() },
	returns: publicKeyProjectionValidator,
	handler: async (ctx, args) => {
		if (!(await isFeatureEnabled(ctx, 'sealedMail'))) return null;
		// The ACTIVE row — after a rotation an address has an old decrypt-only row
		// too, and we must publish the CURRENT public key for discovery.
		const row = await activeAddressRow(ctx, normalizeEmail(args.address));
		if (!row) return null;
		return { fingerprint: row.fingerprint, publicKeyArmored: row.publicKeyArmored };
	},
});

/**
 * PUBLIC: the BINARY public-key body for a WKD `hu/<hash>` fetch, matched by
 * `domain` (the request host) + the local-part `wkdHash`. Returns the base64
 * of the `application/octet-stream` body; the Nuxt route decodes and serves it.
 */
export const getKeyForWkd = publicQuery({
	// public: WKD serves public key material to the world by design (draft-koch).
	args: { domain: v.string(), wkdHash: v.string() },
	returns: v.union(v.null(), v.object({ binaryBase64: v.string() })),
	handler: async (ctx, args) => {
		if (!(await isFeatureEnabled(ctx, 'sealedMail'))) return null;
		const domain = args.domain.toLowerCase();
		// After a rotation, the domain+wkdHash matches BOTH the retired and the new
		// row (same local-part). Serve the ACTIVE key so a WKD fetch returns the
		// current published key rather than whichever the index yields first.
		const rows = await ctx.db
			.query('keyVault')
			.withIndex('by_wkd', (q) => q.eq('domain', domain).eq('wkdHash', args.wkdHash))
			.collect(); // bounded: active + retired rows for one local-part.
		const row = rows.find((r) => r.isActive);
		if (!row) return null;
		return { binaryBase64: row.publicKeyBinaryBase64 };
	},
});

/** PUBLIC: the instance signing identity's public key (for verifying the manifest). */
export const getInstancePublicKey = publicQuery({
	// public: the instance identity public key is published in the signed manifest.
	args: {},
	returns: publicKeyProjectionValidator,
	handler: async (ctx) => {
		if (!(await isFeatureEnabled(ctx, 'sealedMail'))) return null;
		const row = await ctx.db
			.query('keyVault')
			.withIndex('by_kind', (q) => q.eq('kind', 'instance'))
			.first();
		if (!row || !row.isActive) return null;
		return { fingerprint: row.fingerprint, publicKeyArmored: row.publicKeyArmored };
	},
});

/**
 * Every `keyVault` row's subject + its armored public key, so the Node plane can
 * detect which keys are still on the old RFC 9580 new-style profile and re-mint
 * them onto the GnuPG-compatible legacy profile. Internal — read by the re-mint
 * migration action; carries PUBLIC material only (never the sealed private half).
 */
export const listKeyProfiles = internalQuery({
	args: {},
	handler: async (ctx) => {
		const rows = await ctx.db.query('keyVault').collect(); // bounded: one row per address + the single instance identity.
		return rows
			.filter((r) => r.isActive)
			.map((r) => ({
				kind: r.kind,
				address: r.address,
				fingerprint: r.fingerprint,
				publicKeyArmored: r.publicKeyArmored,
			}));
	},
});

/**
 * Every sendable Postbox address (mailbox canonical addresses + aliases) that
 * does NOT yet have an active `keyVault` key. The idempotent backfill worklist.
 * Internal — read by the backfill action.
 */
export const listAddressesNeedingKeys = internalQuery({
	args: {},
	handler: async (ctx) => {
		const mailboxes = await ctx.db.query('mailboxes').collect(); // bounded: per-user mailboxes on a single-org instance.
		const aliases = await ctx.db.query('mailAliases').collect(); // bounded: per-mailbox aliases on a single-org instance.

		const wanted = new Set<string>();
		for (const mb of mailboxes) wanted.add(normalizeEmail(mb.address));
		for (const a of aliases) wanted.add(normalizeEmail(a.alias));

		const existing = await ctx.db
			.query('keyVault')
			.withIndex('by_kind', (q) => q.eq('kind', 'address'))
			.collect(); // bounded: one row per address.
		for (const row of existing) {
			if (row.isActive && row.address) wanted.delete(row.address);
		}
		return Array.from(wanted);
	},
});

/**
 * Admin: mint + publish encryption keys for every address that lacks one (and
 * the instance identity). Idempotent — safe to re-run. Flag-gated behind
 * `sealedMail`; schedules the Node backfill action which does keygen/sealing.
 */
export const backfillKeys = adminMutation({
	args: {},
	handler: async (ctx) => {
		await assertFeatureEnabled(ctx, 'sealedMail');
		await ctx.scheduler.runAfter(0, internal.e2ee.keysNode.runBackfill, {});
		return { scheduled: true as const };
	},
});

/**
 * Admin: local key-publication status for the delivery-readiness surface.
 * Reports whether the instance signing identity exists and how many address
 * keys are published — the local truth the "encryption keys published" readiness
 * check reads. The live counterpart that self-fetches our own WKD + manifest is
 * `domains/encryptionKeysReadiness.checkEncryptionKeysReadiness`.
 */
export const getReadiness = adminQuery({
	args: {},
	handler: async (ctx) => {
		const instance = await ctx.db
			.query('keyVault')
			.withIndex('by_kind', (q) => q.eq('kind', 'instance'))
			.first();
		const addressKeys = await ctx.db
			.query('keyVault')
			.withIndex('by_kind', (q) => q.eq('kind', 'address'))
			.collect(); // bounded: one row per address.
		const activeAddressKeys = addressKeys.filter((r) => r.isActive).length;
		return {
			instanceIdentityPublished: instance !== null && instance.isActive,
			addressKeyCount: activeAddressKeys,
			isPublished: instance !== null && instance.isActive && activeAddressKeys > 0,
		};
	},
});
