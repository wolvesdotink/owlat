/**
 * Recipient-key discovery cache + TOFU trust ledger — the V8 (query/mutation)
 * plane of Sealed Mail key discovery.
 *
 * The fetch + OpenPGP logic lives in the `'use node'` sibling `e2ee/discovery.ts`
 * (it needs `openpgp`/`fetch`/`dns`); this file owns the DB reads/writes for the
 * `recipientKeys` table, including the TOFU transition itself, so every pin
 * change is decided against the row it replaces:
 *   - `getCached` (internal) — cache read the discovery action consults;
 *   - `commitDiscoveredKey` (internal) — commit a discovered key as an atomic
 *     trust transition, evaluated against the row at commit time;
 *   - `recordDiscoveryMiss` (internal) — freshness-only update for a miss;
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
 * without a database); this file and its row helpers in
 * `e2ee/recipientKeyTransitions.ts` are the only place those decisions become rows.
 */

import { v } from 'convex/values';
import type { Id } from '../_generated/dataModel';
import { internalMutation, internalQuery } from '../_generated/server';
import { adminMutation, authedMutation, authedQuery } from '../lib/authedFunctions';
import { assertFeatureEnabled } from '../lib/featureFlags';
import { normalizeEmail } from '@owlat/shared';
import { throwForbidden } from '../_utils/errors';
import { fingerprintsEqual, normalizeFingerprint, reacceptObservedKey } from './pinning';
import { loadRow, samePin, writeDiscoveredKey, writeMiss } from './recipientKeyTransitions';

const outcomeValidator = v.union(
	v.literal('trusted'),
	v.literal('keyChanged'),
	v.literal('notFound')
);
const sourceValidator = v.union(v.literal('wkd'), v.literal('manifest'));
const pinActionValidator = v.union(
	v.literal('firstUse'),
	v.literal('unchanged'),
	v.literal('signedRotation'),
	v.literal('keyChanged'),
	v.literal('reaccept')
);

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
 * Record a discovery MISS (no usable key, or the lookup failed) against the row
 * as it is NOW. Only freshness/discovery metadata changes, so a miss whose lookup
 * started before a pin was committed cannot remove or alter that pin. A pinned
 * row is re-checked sooner; an unpinned one is (or becomes) the negative entry.
 */
export const recordDiscoveryMiss = internalMutation({
	args: {
		address: v.string(),
		domain: v.string(),
		instanceFingerprint: v.optional(v.string()),
		expiresAt: v.number(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const address = normalizeEmail(args.address);
		const { row } = await loadRow(ctx, address);
		await writeMiss(ctx, address, row, args);
		return null;
	},
});

/**
 * Commit a discovered key as one atomic trust transition. The discovery action
 * has already done the network and OpenPGP work (SSRF-guarded fetch, key<->address
 * binding, rotation-signature check); the TOFU decision itself is made HERE, by
 * `evaluatePin`, against the row as it is at commit time.
 *
 * `basis` is the revision and pin the action read before its fetch. If the row
 * has moved on since (another discovery, a signed rotation, an operator
 * re-accept), nothing is written and `stale` is returned so the caller starts
 * over from a fresh read. Re-evaluating the old observation against the new row
 * instead would let a key fetched BEFORE a newer transition (say, the old key
 * the peer just rotated away from) flip a freshly trusted row to `keyChanged`.
 *
 * `rotation` is the old -> new pair a signed rotation statement was verified
 * for. It only counts when that old fingerprint is the pin on the row now and
 * the new one is the key being committed; a statement verified against any other
 * pin is ignored and the change is treated as unsigned.
 */
export const commitDiscoveredKey = internalMutation({
	args: {
		address: v.string(),
		domain: v.string(),
		basis: v.object({
			revision: v.number(),
			pinnedFingerprint: v.optional(v.string()),
		}),
		fingerprint: v.string(),
		publicKeyArmored: v.string(),
		source: sourceValidator,
		rotation: v.optional(v.object({ oldFingerprint: v.string(), newFingerprint: v.string() })),
		instanceFingerprint: v.optional(v.string()),
		expiresAt: v.number(),
	},
	returns: v.union(
		v.object({
			status: v.literal('committed'),
			outcome: v.union(v.literal('trusted'), v.literal('keyChanged')),
			action: pinActionValidator,
		}),
		v.object({ status: v.literal('stale'), outcome: v.union(outcomeValidator, v.null()) })
	),
	handler: async (ctx, args) => {
		const address = normalizeEmail(args.address);
		const { row, revision } = await loadRow(ctx, address);
		if (
			revision !== args.basis.revision ||
			!samePin(row?.pinnedFingerprint, args.basis.pinnedFingerprint)
		) {
			return { status: 'stale' as const, outcome: row?.outcome ?? null };
		}
		const { outcome, action } = await writeDiscoveredKey(ctx, address, row, revision, args);
		return { status: 'committed' as const, outcome, action };
	},
});

// ============== v0.6.5 compatibility shim — remove after release N+1 ==============
//
// v0.6.5's discovery action decided the pin itself and wrote it through
// `upsertDiscovery`. One still running when this release deploys resolves that
// call here (CONVENTIONS.md, "Old clients and workers against new functions").
// It carries no record of the row it read, and on a miss it copies that row's
// pin, observed key and outcome back, so a v0.6.5 miss on a pinned row looks
// like a positive write. Only writes that cannot depend on the row it read are
// applied:
//   - `notFound`: freshness only (`writeMiss`);
//   - the old action trusted the observed key (`trusted`, pin === observed) and
//     the row has no pin now: a first pin;
//   - the same, and the row already trusts that same key: freshness only. The
//     stored key material is left alone, since the payload may carry an older
//     copy of it.
// Anything else is dropped; the next discovery evaluates it against the
// current row.

/** Remove after release N+1: v0.6.5 compatibility (see the section comment above). */
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
	handler: async (ctx, args): Promise<{ id: Id<'recipientKeys'> | null; created: boolean }> => {
		const address = normalizeEmail(args.address);
		const { row, revision } = await loadRow(ctx, address);
		if (args.outcome === 'notFound') return await writeMiss(ctx, address, row, args);

		const observed = args.observedFingerprint;
		const armored = args.observedPublicKeyArmored;
		const trustedObserved =
			args.outcome === 'trusted' &&
			!!observed &&
			!!armored &&
			samePin(args.pinnedFingerprint, observed);
		if (!trustedObserved) return { id: row?._id ?? null, created: false };

		if (row?.pinnedFingerprint) {
			const isRefresh =
				row.outcome === 'trusted' && fingerprintsEqual(row.pinnedFingerprint, observed);
			if (!isRefresh) return { id: row._id, created: false };
			return await writeMiss(ctx, address, row, args);
		}
		const { id, created } = await writeDiscoveredKey(ctx, address, row, revision, {
			domain: args.domain,
			fingerprint: observed,
			publicKeyArmored: armored,
			source: args.source ?? 'wkd',
			instanceFingerprint: args.instanceFingerprint,
			expiresAt: args.expiresAt,
		});
		return { id, created };
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
 *
 * `observedFingerprint` is the key the operator was shown and is accepting. If
 * discovery has since observed a different key, the acceptance does not cover
 * it and nothing changes; the caller re-reads and decides again. A successful
 * re-accept advances the trust revision, so a discovery that read the row
 * before it cannot commit on top of it.
 */
export const reacceptKeyChange = adminMutation({
	args: {
		address: v.string(),
		// Optional only for v0.6.5 web/desktop clients that do not send it yet —
		// remove after release N+1 (make it required).
		observedFingerprint: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		await assertFeatureEnabled(ctx, 'sealedMail');
		const address = normalizeEmail(args.address);
		const { row, revision } = await loadRow(ctx, address);
		if (!row || row.outcome !== 'keyChanged' || !row.observedFingerprint) {
			return { reaccepted: false as const };
		}
		if (
			args.observedFingerprint !== undefined &&
			!fingerprintsEqual(row.observedFingerprint, args.observedFingerprint)
		) {
			return { reaccepted: false as const };
		}
		const decision = reacceptObservedKey(row.observedFingerprint);
		await ctx.db.patch(row._id, {
			outcome: 'trusted',
			pinnedFingerprint: decision.pinnedFingerprint,
			pinnedPublicKeyArmored: row.observedPublicKeyArmored,
			revision: revision + 1,
			updatedAt: Date.now(),
		});
		return { reaccepted: true as const, pinnedFingerprint: decision.pinnedFingerprint };
	},
});
