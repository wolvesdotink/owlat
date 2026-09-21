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
 *   - `setContactKeyVerified` (authed member) — record/withdraw the HUMAN
 *     verification of a contact's key (plan idea 54).
 *
 * Nothing here uses `authedIdentityMutation` (a locked Sealed-Mail rule).
 *
 * The pure decision logic these writes apply lives in `e2ee/pinning.ts`, which
 * stays free of Convex imports by design (its whole state machine is testable
 * without a database); this file is the only place those decisions become rows.
 */

import { v } from 'convex/values';
import { internalMutation, internalQuery } from '../_generated/server';
import { adminMutation, authedMutation, authedQuery } from '../lib/authedFunctions';
import { assertFeatureEnabled } from '../lib/featureFlags';
import { normalizeEmail } from '@owlat/shared';
import { throwForbidden } from '../_utils/errors';
import { fingerprintsEqual, normalizeFingerprint, reacceptObservedKey } from './pinning';

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
 * PINNED addresses whose cache entry expires at/before `before`, oldest first.
 * The scheduled refresh cron pages this worklist and re-discovers each — its
 * purpose is rotated-key pickup, so it is scoped to rows that actually hold a
 * pin. A `notFound` negative (no pin) is intentionally NOT refreshed here:
 * on-demand discovery already re-checks negatives via `shouldRefetch` when a
 * send needs the address, so an address that never publishes a key does not get
 * fetched hourly forever. Internal.
 */
export const listExpiring = internalQuery({
	args: { before: v.number(), limit: v.number() },
	handler: async (ctx, args) => {
		const rows = await ctx.db
			.query('recipientKeys')
			.withIndex('by_expiresAt', (q) => q.lte('expiresAt', args.before))
			.filter((q) => q.neq(q.field('pinnedFingerprint'), undefined))
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
// all-members: any authenticated org member may read a recipient's PUBLIC key /
// pin state — it backs the reader's Sealed-Mail badge and returns only
// fingerprints + TOFU trust state (no private material exists in this table).
// Authed (not public) solely so the row set isn't an anonymous enumeration
// oracle for whom this org seals mail to.
export const getRecipientKeyStatus = authedQuery({
	args: { address: v.string() },
	returns: v.union(
		v.null(),
		v.object({
			outcome: outcomeValidator,
			pinnedFingerprint: v.union(v.string(), v.null()),
			observedFingerprint: v.union(v.string(), v.null()),
			// First-seen timestamp + discovery source, for the per-contact key panel
			// (E5). Public metadata: WHEN we first pinned a key and WHERE we found it.
			discoveredAt: v.union(v.number(), v.null()),
			source: v.union(sourceValidator, v.null()),
			expiresAt: v.number(),
			// Human verification (idea 54). The CHECKED fingerprint rides along so
			// the client resolves the same three-way state the backend does —
			// verified / stale / unverified — from this one read.
			verifiedFingerprint: v.union(v.string(), v.null()),
			verifiedAt: v.union(v.number(), v.null()),
			// Whether the CALLER is the one who made the claim. The user id itself
			// stays server-side: "you" versus "a teammate" is the whole distinction
			// the copy needs, and the id would hand the roster to anyone who can read
			// a contact.
			verifiedByMe: v.boolean(),
		})
	),
	handler: async (ctx, args, session) => {
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
			discoveredAt: row.discoveredAt ?? null,
			source: row.source ?? null,
			expiresAt: row.expiresAt,
			verifiedFingerprint: row.verifiedFingerprint ?? null,
			verifiedAt: row.verifiedAt ?? null,
			verifiedByMe: !!row.verifiedBy && row.verifiedBy === session.userId,
		};
	},
});

/**
 * Record — or withdraw — the HUMAN verification of a contact's sealing key
 * (plan idea 54). TOFU already decided which key we seal to; this records that a
 * person compared that fingerprint with its owner over some other channel and it
 * matched.
 *
 * Three properties make the claim trustworthy:
 *
 *   1. It is bound to a FINGERPRINT the caller passed in, which must still equal
 *      the current pin. A panel that has been open since before a rotation
 *      therefore cannot mark a key its reader never actually saw — the call
 *      fails instead, and they re-read the fresh one.
 *   2. It is ATTRIBUTED (`verifiedBy`), so the badge can say who made it.
 *   3. It expires by construction: the stored fingerprint stops matching the pin
 *      the moment the key changes, and `resolveVerificationState` reads that as
 *      stale (see `schema/e2ee.ts`).
 *
 * Any org member may set it — unlike `reacceptKeyChange` this changes NOTHING
 * about which key Owlat seals to, it only annotates the key already pinned, and
 * a verification ritual that needed an admin in the room is a ritual nobody
 * performs. Withdrawing (`verified: false`) needs no fingerprint match: removing
 * a trust claim is always the safe direction.
 */
// authz: authedMutation (any org member). Deliberately NOT admin: this records
// an attributed human observation about a PUBLIC fingerprint and cannot change
// the pinned key, so it is strictly weaker than reacceptKeyChange next door.
export const setContactKeyVerified = authedMutation({
	args: {
		address: v.string(),
		verified: v.boolean(),
		// Required when verifying: the fingerprint the caller actually compared.
		fingerprint: v.optional(v.string()),
	},
	returns: v.object({ verified: v.boolean() }),
	handler: async (ctx, args, session) => {
		await assertFeatureEnabled(ctx, 'sealedMail');
		const address = normalizeEmail(args.address);
		const row = await ctx.db
			.query('recipientKeys')
			.withIndex('by_address', (q) => q.eq('address', address))
			.first();
		if (!row) throwForbidden('No sealing key is known for this address');

		if (!args.verified) {
			await ctx.db.patch(row._id, {
				verifiedFingerprint: undefined,
				verifiedAt: undefined,
				verifiedBy: undefined,
				updatedAt: Date.now(),
			});
			return { verified: false };
		}

		// Verifying a key we would not seal to is meaningless, and verifying one
		// the caller did not see is the whole failure this guard exists for.
		if (!row.pinnedFingerprint || row.outcome !== 'trusted') {
			throwForbidden('This address has no trusted key to verify');
		}
		if (!args.fingerprint || !fingerprintsEqual(args.fingerprint, row.pinnedFingerprint)) {
			throwForbidden('The key changed since it was displayed; check the new one');
		}
		await ctx.db.patch(row._id, {
			verifiedFingerprint: normalizeFingerprint(row.pinnedFingerprint),
			verifiedAt: Date.now(),
			verifiedBy: session.userId,
			updatedAt: Date.now(),
		});
		return { verified: true };
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
