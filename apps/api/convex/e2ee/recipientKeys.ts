/**
 * Recipient-key discovery cache + TOFU trust ledger — the V8 (query/mutation)
 * plane of Sealed Mail key discovery.
 *
 * The fetch + OpenPGP + pin-evaluation logic lives in the `'use node'` sibling
 * `e2ee/discovery.ts` (it needs `openpgp`/`fetch`/`dns`); this file owns the DB
 * reads/writes for the `recipientKeys` table:
 *   - `getCached` (internal) — cache read the discovery action consults;
 *   - `upsertDiscovery` (internal) — persist a discovery + pin decision;
 *   - `listExpiring` (internal) — the refresh-cron worklist;
 *   - `getRecipientKeyStatus` (authed org-member read) — the recipient's PUBLIC
 *     key / trust state for a UI (never any private material — there is none
 *     here). Authed, not public: the row set is this org's inbound discovery
 *     cache, so *which* addresses we have pinned keys for is org-private
 *     correspondence metadata that must not be an anonymous enumeration oracle.
 *   - `reacceptKeyChange` (admin) — the explicit re-accept transition.
 *
 * Nothing here uses `authedIdentityMutation` (a locked Sealed-Mail rule).
 */

import { v } from 'convex/values';
import { internalMutation, internalQuery } from '../_generated/server';
import { adminMutation, authedQuery } from '../lib/authedFunctions';
import { assertFeatureEnabled } from '../lib/featureFlags';
import { normalizeEmail } from '@owlat/shared';
import { reacceptObservedKey } from './pinning';

const outcomeValidator = v.union(
	v.literal('trusted'),
	v.literal('keyChanged'),
	v.literal('notFound')
);
const sourceValidator = v.union(v.literal('wkd'), v.literal('manifest'));

/**
 * The cached discovery row for an address (incl. the pinned + observed public
 * material). Internal — read by the discovery action to decide whether the cache
 * is still fresh and to load the current pin for a rotation check.
 */
export const getCached = internalQuery({
	args: { address: v.string() },
	handler: async (ctx, args) => {
		const address = normalizeEmail(args.address);
		return ctx.db
			.query('recipientKeys')
			.withIndex('by_address', (q) => q.eq('address', address))
			.first();
	},
});

/**
 * Persist a discovery + pin decision. Idempotent upsert on `address`. The
 * caller (discovery action) has already run the SSRF-guarded fetch, validated
 * the key<->address binding, and evaluated the TOFU pin, so this is a pure
 * write: it never re-pins on its own.
 */
export const upsertDiscovery = internalMutation({
	args: {
		address: v.string(),
		domain: v.string(),
		outcome: outcomeValidator,
		pinnedFingerprint: v.optional(v.string()),
		pinnedPublicKeyArmored: v.optional(v.string()),
		observedFingerprint: v.optional(v.string()),
		observedPublicKeyArmored: v.optional(v.string()),
		source: v.optional(sourceValidator),
		instanceFingerprint: v.optional(v.string()),
		expiresAt: v.number(),
	},
	handler: async (ctx, args) => {
		const address = normalizeEmail(args.address);
		const now = Date.now();
		const existing = await ctx.db
			.query('recipientKeys')
			.withIndex('by_address', (q) => q.eq('address', address))
			.first();

		const fields = {
			address,
			domain: args.domain.toLowerCase(),
			outcome: args.outcome,
			pinnedFingerprint: args.pinnedFingerprint,
			pinnedPublicKeyArmored: args.pinnedPublicKeyArmored,
			observedFingerprint: args.observedFingerprint,
			observedPublicKeyArmored: args.observedPublicKeyArmored,
			source: args.source,
			instanceFingerprint: args.instanceFingerprint,
			expiresAt: args.expiresAt,
			updatedAt: now,
		};

		if (existing) {
			await ctx.db.patch(existing._id, fields);
			return { id: existing._id, created: false as const };
		}
		const id = await ctx.db.insert('recipientKeys', { ...fields, discoveredAt: now });
		return { id, created: true as const };
	},
});

/**
 * Addresses whose cache entry expires at/before `before`, oldest first. The
 * scheduled refresh cron pages this worklist and re-discovers each. Internal.
 */
export const listExpiring = internalQuery({
	args: { before: v.number(), limit: v.number() },
	handler: async (ctx, args) => {
		const rows = await ctx.db
			.query('recipientKeys')
			.withIndex('by_expiresAt', (q) => q.lte('expiresAt', args.before))
			.take(Math.max(1, Math.min(args.limit, 200)));
		return rows.map((r) => r.address);
	},
});

/**
 * The discovery/trust status for an address — the recipient's PUBLIC key
 * material and pin state only (no private material lives in this table). Backs
 * the reader's "Sealed - sender verified" / "key changed" UI. Authed to an org
 * member: the presence of a row (and its trust state) reveals whom this org
 * seals mail to, which is org-private correspondence metadata, so it is NOT an
 * anonymous read even though the key bytes themselves are public.
 */
export const getRecipientKeyStatus = authedQuery({
	args: { address: v.string() },
	returns: v.union(
		v.null(),
		v.object({
			outcome: outcomeValidator,
			pinnedFingerprint: v.union(v.string(), v.null()),
			observedFingerprint: v.union(v.string(), v.null()),
			expiresAt: v.number(),
		})
	),
	handler: async (ctx, args) => {
		const address = normalizeEmail(args.address);
		const row = await ctx.db
			.query('recipientKeys')
			.withIndex('by_address', (q) => q.eq('address', address))
			.first();
		if (!row) return null;
		return {
			outcome: row.outcome,
			pinnedFingerprint: row.pinnedFingerprint ?? null,
			observedFingerprint: row.observedFingerprint ?? null,
			expiresAt: row.expiresAt,
		};
	},
});

/**
 * Admin: explicitly re-accept a `keyChanged` conflict — adopt the observed key
 * as the new pin (the only path that re-pins across an UNSIGNED key change).
 * No-op unless the row is currently in `keyChanged` with a stored observed key.
 */
export const reacceptKeyChange = adminMutation({
	args: { address: v.string() },
	handler: async (ctx, args) => {
		await assertFeatureEnabled(ctx, 'sealedMail');
		const address = normalizeEmail(args.address);
		const row = await ctx.db
			.query('recipientKeys')
			.withIndex('by_address', (q) => q.eq('address', address))
			.first();
		if (!row || row.outcome !== 'keyChanged' || !row.observedFingerprint) {
			return { reaccepted: false as const };
		}
		const decision = reacceptObservedKey(row.observedFingerprint);
		await ctx.db.patch(row._id, {
			outcome: 'trusted',
			pinnedFingerprint: decision.pinnedFingerprint,
			pinnedPublicKeyArmored: row.observedPublicKeyArmored,
			updatedAt: Date.now(),
		});
		return { reaccepted: true as const, pinnedFingerprint: decision.pinnedFingerprint };
	},
});
