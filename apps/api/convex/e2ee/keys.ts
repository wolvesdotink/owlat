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
import { internalMutation, internalQuery } from '../_generated/server';
import { internal } from '../_generated/api';
import { adminMutation, adminQuery, publicQuery } from '../lib/authedFunctions';
import { assertFeatureEnabled } from '../lib/featureFlags';
import { normalizeEmail } from '@owlat/shared';

const sealedPrivateKeyValidator = v.object({
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
	},
	handler: async (ctx, args) => {
		const now = Date.now();
		const existing =
			args.kind === 'instance'
				? await ctx.db
						.query('keyVault')
						.withIndex('by_kind', (q) => q.eq('kind', 'instance'))
						.first()
				: args.address
					? await ctx.db
							.query('keyVault')
							.withIndex('by_address', (q) => q.eq('address', args.address))
							.first()
					: null;

		if (existing) {
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
			return { id: existing._id, created: false as const };
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
	handler: async (ctx, args) => {
		const normalized = normalizeEmail(args.address);
		const row = await ctx.db
			.query('keyVault')
			.withIndex('by_address', (q) => q.eq('address', normalized))
			.first();
		return row && row.isActive ? row : null;
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
		return rows
			.filter((r) => r.isActive && r.address)
			.map((r) => ({ address: r.address as string, fingerprint: r.fingerprint }));
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
		const normalized = normalizeEmail(args.address);
		const row = await ctx.db
			.query('keyVault')
			.withIndex('by_address', (q) => q.eq('address', normalized))
			.first();
		if (!row || !row.isActive) return null;
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
		const domain = args.domain.toLowerCase();
		const row = await ctx.db
			.query('keyVault')
			.withIndex('by_wkd', (q) => q.eq('domain', domain).eq('wkdHash', args.wkdHash))
			.first();
		if (!row || !row.isActive) return null;
		return { binaryBase64: row.publicKeyBinaryBase64 };
	},
});

/** PUBLIC: the instance signing identity's public key (for verifying the manifest). */
export const getInstancePublicKey = publicQuery({
	// public: the instance identity public key is published in the signed manifest.
	args: {},
	returns: publicKeyProjectionValidator,
	handler: async (ctx) => {
		const row = await ctx.db
			.query('keyVault')
			.withIndex('by_kind', (q) => q.eq('kind', 'instance'))
			.first();
		if (!row || !row.isActive) return null;
		return { fingerprint: row.fingerprint, publicKeyArmored: row.publicKeyArmored };
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
 * keys are published — the local truth a "encryption keys published" readiness
 * check reads (a live self-fetch of WKD/manifest is a later transport piece).
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
