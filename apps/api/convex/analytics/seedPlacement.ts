/**
 * Seed mailbox placement (module) — gate 5 of the deliverability controller,
 * and the only placement signal that needs no third-party account at all.
 *
 * The operator connects a handful of free consumer mailboxes through the
 * SHIPPED external-account flow (`mail/externalAccounts.ts`,
 * `externalMailAccounts`) tagged `purpose: 'seed'`; every send drops a shadow
 * copy into each of them (`delivery/seedShadowCopy.ts`); the shipped IMAP
 * client walks the mailbox, finds the `X-Owlat-Seed-Probe` header and reports
 * which FOLDER the probe landed in. This module is the Convex half: it owns
 * the probe ledger and the roll-up that feeds the controller.
 *
 * Every decision lives in the pure core (`@owlat/shared/seedPlacement`): this
 * file loads, calls, and writes (D15).
 *
 * D17 — TRIPWIRE, NOT A GAUGE. Nothing here returns a placement percentage.
 * The roll-up is a STATUS per mailbox provider, and a provider-wide collapse
 * is SUSPECT until the deferral or bounce gate corroborates it.
 *
 * D2 — ADDITIVE-ONLY. Zero seed mailboxes is a supported configuration:
 * `getGateVerdict` answers `insufficient_data`, the controller HOLDS, and
 * nothing errors, warns, or nags.
 *
 * WHAT THIS MODULE OWNS, AND WHAT IT HANDS ON. It owns the probe ledger, the
 * per-provider roll-up, gate 5's verdict, and `getSeedPlacementSummary` for a
 * screen to read. The seed ACCOUNTS themselves — the projection and the
 * rotation nudge — are the domain sibling `analytics/seedAccounts.ts`, and the
 * two ledger sweeps are `analytics/seedProbeLedger.ts`. It does NOT own the CELL
 * DASHBOARD that renders the status or the confidence line beside it — that is
 * P3-6 (Independence & Cells UI) and P3-8 (confidence surfacing), which consume
 * `getSeedPlacementSummary` as it stands. The scheduled TRANSACTIONAL-stream
 * probe is P4-7's (`delivery/seedShadowCopy.ts` shadows a campaign send only);
 * the `stream` column is already the cell axis, so that is an additive widening
 * rather than a reshaping.
 *
 * SECURITY. Seed credentials are the SAME sealed envelope every other external
 * account uses; this module never reads, returns, or logs them. Seed mailbox
 * CONTENTS are never read into Convex — the poller reports a folder NAME and
 * nothing else. Only `toSeedAccountLogView` output is ever safe to log.
 */

import { v } from 'convex/values';
import { internalMutation, internalQuery, type DatabaseReader } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import {
	classifySeedFolder,
	evaluateSeedPlacementGate,
	planSeedHygiene,
	type SeedGateResult,
	type SeedObservation,
	type SeedProviderRollup,
} from '@owlat/shared/seedPlacement';
import {
	resolvePlacementAdapter,
	type PlacementImprovementHint,
	type PlacementSourceKind,
} from '@owlat/shared/placementAdapter';
import type { SeedConfidence } from '@owlat/shared/seedPlacement';
import { loadSeedAccounts } from './seedAccounts';

/** Rolling window the roll-up reads. Short enough that a collapse shows up fast. */
export const SEED_PLACEMENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// ── The module's bounds, grouped: every page size and horizon in one place, so
// the ledger's cost profile can be read without walking the file.

/** Hard page bound — the ledger is never `.collect()`ed (D16). */
const SEED_PROBE_SCAN_LIMIT = 500;

/**
 * How long a probe may sit un-dispatched before it is written off. Generous on
 * purpose: a warming-capped deployment can hold a campaign page in the
 * workpool for many hours, and a probe that eventually goes out is a perfectly
 * good observation.
 */
export const SEED_PROBE_DISPATCH_HORIZON_MS = 48 * 60 * 60 * 1000;

/**
 * Maximum stored length of a remote folder name (and of the category label
 * derived from it).
 *
 * A folder name arrives from an IMAP server whose software the operator does
 * not choose, so it is remote input like any other: bounded at the mutation
 * boundary rather than stored verbatim. IMAP mailbox names are modified UTF-7
 * paths and real ones are far shorter than this; the bound exists so a
 * pathological name cannot inflate a ledger row that is written once per seed
 * per campaign. Truncation is display-only — no decision reads the string.
 */
const SEED_FOLDER_NAME_MAX_LENGTH = 256;

/**
 * Clamp a remote folder name to something safe to store and render: control
 * characters (including the CR/LF that would let a folder name forge a line in
 * an operator-facing log) are dropped, and the result is length-bounded.
 */
function clampRemoteFolderName(value: string): string {
	// Character codes rather than a control-character regex: the regex form is a
	// lint error in this repo, and the intent reads more plainly this way.
	//
	// SANITIZE FIRST, THEN BOUND BY CODE POINT. `String.slice` counts UTF-16 code
	// units, so slicing a name first can cut an astral character in half and
	// store a lone surrogate — an unpaired half that no longer round-trips
	// through JSON and renders as a replacement glyph. Iterating the string
	// yields whole code points, so the bound is applied to characters.
	const sanitized: string[] = [];
	for (const char of value) {
		const code = char.codePointAt(0) ?? 0;
		sanitized.push(code < 0x20 || code === 0x7f ? ' ' : char);
		if (sanitized.length >= SEED_FOLDER_NAME_MAX_LENGTH) break;
	}
	return sanitized.join('');
}

// ============ THE TENANT BOUNDARY, ONCE ============

/**
 * Load a probe row the caller is allowed to write, by probe id or by row ref.
 *
 * Every probe-writing mutation opens with the SAME two questions — does this row
 * exist, and does it belong to the organization the caller claims — and the
 * answer to the second is the tenant boundary of this whole module. Three
 * copies of it is three places for it to drift; this is the one implementation,
 * and the discriminated result keeps each caller's own no-op reasons distinct
 * from it.
 *
 * The order is deliberate and load-bearing: the boundary is asserted BEFORE any
 * caller-specific state check, so no branch of a mutation can become reachable
 * only for rows in a state the caller is not entitled to know about.
 */
type OwnedProbeResult =
	| { ok: true; probe: Doc<'seedPlacementProbes'> }
	| { ok: false; reason: 'unknown_probe' | 'foreign_organization' };

async function loadOwnedProbe(
	db: DatabaseReader,
	organizationId: string,
	ref: { probeId: string } | { probeRef: Id<'seedPlacementProbes'> }
): Promise<OwnedProbeResult> {
	const probe =
		'probeRef' in ref
			? await db.get(ref.probeRef)
			: await db
					.query('seedPlacementProbes')
					.withIndex('by_probe_id', (q) => q.eq('probeId', ref.probeId))
					.unique();
	// EVERY failure branch names its reason: the mail-sync worker has to be able
	// to tell "not yours" (a bug in the sweep's org scoping — loud) from "gone"
	// (the retention cleanup won the race — expected, drop it).
	if (!probe) return { ok: false, reason: 'unknown_probe' };
	if (probe.organizationId !== organizationId) {
		return { ok: false, reason: 'foreign_organization' };
	}
	return { ok: true, probe };
}

// ============ CLASSIFICATION ============

/**
 * The poller's report for ONE probe. `folderName` is `null` when every folder
 * of the seed mailbox was walked and the probe was not found — MISSING.
 * No subject, no body, no sender: mailbox contents never enter Convex.
 */
export const recordSeedProbeClassification = internalMutation({
	args: {
		organizationId: v.string(),
		probeId: v.string(),
		folderName: v.union(v.string(), v.null()),
		/**
		 * The folder's RFC 6154 SPECIAL-USE attribute (`\Junk`, `\Trash`) when the
		 * server advertised one. It DECIDES ahead of the folder name: names are
		 * localized per account language, and an unrecognised name falls through to
		 * `category`, which counts as reached.
		 */
		specialUse: v.optional(v.string()),
		now: v.number(),
		/** Uniform [0,1) draw for the occasional click. Randomness stays at the edge. */
		clickRoll: v.number(),
	},
	handler: async (ctx, args) => {
		// Existence + the tenant boundary, in the one implementation all three
		// probe-writing mutations share.
		const owned = await loadOwnedProbe(ctx.db, args.organizationId, { probeId: args.probeId });
		if (!owned.ok) return { recorded: false as const, reason: owned.reason };
		const probe = owned.probe;
		// A probe we never handed to a transport is NOT evidence — it was never
		// mailed, so no folder is the right answer and `missing` is the wrong one.
		// The work selection already excludes it; this is the load-bearing check,
		// because `missing` is the outcome that feeds the collapse tripwire and it
		// must never be manufactured by our own queue.
		if (probe.dispatchedAt === undefined) {
			return { recorded: false as const, reason: 'never_dispatched' as const };
		}
		// THE SINGLE ARBITER of "has this probe been classified". mail-sync runs as
		// many replicas as the deployment scales to, and every one of them sweeps;
		// without this the same probe is classified twice, marked read twice, and
		// CLICKED twice — which is a real message to a real provider, teaching it a
		// pattern no subscriber produces. Classification is once-only and the first
		// writer wins; the loser gets a no-op, not an error.
		if (probe.placement !== undefined) {
			return { recorded: false as const, reason: 'already_classified' as const };
		}

		// The folder name is REMOTE input — it comes off an IMAP server whose
		// software the operator does not choose — so it is bounded before it is
		// stored. Classification still runs on the raw name: clamping is about what
		// we persist and render, not about what we decide.
		const classification = classifySeedFolder(args.folderName, probe.provider, args.specialUse);
		const storedFolderName =
			args.folderName !== null ? clampRemoteFolderName(args.folderName) : null;
		const storedCategoryLabel =
			classification.categoryLabel !== undefined
				? clampRemoteFolderName(classification.categoryLabel)
				: undefined;
		const hygiene = planSeedHygiene({
			placement: classification.placement,
			alreadyMarkedRead: probe.markedReadAt !== undefined,
			alreadyClicked: probe.clickedAt !== undefined,
			clickRoll: args.clickRoll,
		});

		await ctx.db.patch(probe._id, {
			placement: classification.placement,
			classifiedAt: args.now,
			...(storedFolderName !== null ? { folderName: storedFolderName } : {}),
			...(storedCategoryLabel !== undefined ? { categoryLabel: storedCategoryLabel } : {}),
			...(hygiene.markRead ? { markedReadAt: args.now } : {}),
			...(hygiene.click ? { clickedAt: args.now } : {}),
		});

		return {
			recorded: true as const,
			placement: classification.placement,
			hygiene,
		};
	},
});

/**
 * Record which arm actually carried a shadow copy, written by the worker once
 * the governed route resolved. Attribution is the whole point of a placement
 * observation, and the requested `providerType` is not the resolved one.
 */
export const recordSeedProbeDispatch = internalMutation({
	args: {
		organizationId: v.string(),
		probeRef: v.id('seedPlacementProbes'),
		transportArm: v.union(v.literal('own'), v.literal('reference')),
		now: v.number(),
	},
	handler: async (ctx, args) => {
		const owned = await loadOwnedProbe(ctx.db, args.organizationId, { probeRef: args.probeRef });
		if (!owned.ok) return { recorded: false as const, reason: owned.reason };
		// THE SINGLE ARBITER of "which arm carried this probe", the same rule its
		// classification sibling holds. `sendSingleEmail` runs in a workpool that
		// may re-run an action, and a second write would replace the FIRST arm
		// attribution — the whole point of the observation — and restart the
		// poller's give-up horizon, hiding a probe that has already gone missing.
		// First writer wins; the loser gets a no-op, not an error.
		if (owned.probe.dispatchedAt !== undefined) {
			return { recorded: false as const, reason: 'already_dispatched' as const };
		}
		await ctx.db.patch(args.probeRef, {
			transportArm: args.transportArm,
			dispatchedAt: args.now,
		});
		return { recorded: true as const };
	},
});

/**
 * The probe's RFC 8058 one-click target was exercised. There is no contact to
 * unsubscribe — this only timestamps the probe row, so the operator can see
 * that the seed's one-click endpoint really works end to end.
 */
export const recordSeedProbeUnsubscribe = internalMutation({
	args: { organizationId: v.string(), probeId: v.string(), now: v.number() },
	handler: async (ctx, args) => {
		// The shared loader holds the org boundary FIRST, ahead of the state check
		// below. The caller's claim here is the SIGNED one-click token, which
		// carries the organization alongside the probe id precisely so the
		// assertion has something independent to check rather than reading the
		// answer off the row it is about to write. Checking `already_recorded`
		// ahead of it would make one branch of the boundary reachable only for
		// un-recorded probes and turn "already recorded" into a cross-tenant
		// existence answer.
		const owned = await loadOwnedProbe(ctx.db, args.organizationId, { probeId: args.probeId });
		if (!owned.ok) return { recorded: false as const, reason: owned.reason };
		if (owned.probe.unsubscribedAt !== undefined) {
			return { recorded: false as const, reason: 'already_recorded' as const };
		}
		await ctx.db.patch(owned.probe._id, { unsubscribedAt: args.now });
		return { recorded: true as const };
	},
});

// ============ ROLL-UP + GATE 5 ============

export interface SeedPlacementSummary {
	rollups: SeedProviderRollup[];
	/** Seed mailboxes currently connected — the honesty denominator for the UI. */
	seedAccountCount: number;
	/** Seeds the operator should rotate. Advisory only. */
	rotationRemindersDue: number;
	windowStart: number;
	/** Which placement adapter produced {@link rollups} (P4-7). */
	placementSource: PlacementSourceKind;
	/**
	 * How much this reading is worth (D14). Placement evidence is NEVER high
	 * confidence whoever gathered it; the one grade it can carry is the gate's
	 * own `SEED_GATE_CONFIDENCE`, imported rather than restated so the screen
	 * and the controller cannot hold two opinions of one reading. `none` means
	 * there is nothing to read at all yet — the ABSENCE of a grade, not a
	 * weaker one — and the screen says so instead of quoting a percentage.
	 */
	placementConfidence: SeedConfidence;
	/**
	 * The ONE advisory the reading may carry, for rendering next to the
	 * confidence label. A hint, never an error, never a "setup incomplete" nag
	 * and never a reason to withhold a screen or a send (D2).
	 */
	placementImprovement: PlacementImprovementHint;
}

/**
 * Sum the probe ledger for one org into per-provider STATUSES. Reader-typed so
 * the controller and the dashboard read it through the same path and can never
 * disagree (the ADR-0042 rule applied to a second table).
 */
export async function summarizeSeedPlacementWindow(
	db: DatabaseReader,
	organizationId: string,
	now: number
): Promise<SeedPlacementSummary> {
	const windowStart = now - SEED_PLACEMENT_WINDOW_MS;
	const probes = await db
		.query('seedPlacementProbes')
		.withIndex('by_org_and_sent_at', (q) =>
			q.eq('organizationId', organizationId).gte('sentAt', windowStart)
		)
		// Newest first: under volume the tripwire must truncate the OLDEST
		// evidence, never the freshest.
		.order('desc')
		.take(SEED_PROBE_SCAN_LIMIT);

	const observations: SeedObservation[] = [];
	for (const probe of probes) {
		const placement = probe.placement;
		// Unclassified probes are not yet evidence in either direction.
		if (placement === undefined) continue;
		// Which arm carried it is gate 5's second clause. A row with no recorded
		// arm reads as `own`: standalone is the default configuration, and s === 1
		// means every probe went through our own MTA.
		observations.push({
			provider: probe.provider,
			arm: probe.transportArm ?? 'own',
			placement,
		});
	}

	const accounts = await loadSeedAccounts(db, organizationId, now);
	// Gate 5 reads its evidence through the placement ADAPTER rather than the
	// roll-up directly (P4-7). With no commercial placement key — the default and
	// expected configuration — this resolves to the self-hosted seed adapter and
	// the reading is byte-identical to the shipped one; a deployment that later
	// adds a panel feeds the SAME gate through the SAME interface (D2: the key is
	// an upgrade, its absence changes nothing).
	const placement = resolvePlacementAdapter({
		seedMailboxCount: accounts.length,
		commercialApiConfigured: false,
	});
	return {
		rollups: placement.adapter.summarize({ kind: 'self_hosted_seeds', observations }),
		seedAccountCount: accounts.length,
		rotationRemindersDue: accounts.filter((a) => a.rotationReminderDue).length,
		windowStart,
		// The resolution's own verdict, carried through rather than recomputed:
		// this IS D14's "measurement confidence — add seed mailboxes" hint, and
		// it is the resolution that decides both the grade and the hint, not the
		// screen.
		placementSource: placement.kind,
		placementConfidence: placement.confidence,
		placementImprovement: placement.improvement,
	};
}

export const getSeedPlacementSummary = internalQuery({
	args: { organizationId: v.string(), now: v.number() },
	handler: async (ctx, args): Promise<SeedPlacementSummary> =>
		summarizeSeedPlacementWindow(ctx.db, args.organizationId, args.now),
});

/**
 * Gate 5's verdict for the controller.
 *
 * `corroboration` is the CURRENT reading of the deferral and bounce gates: a
 * seed collapse across eight consumer mailboxes may not move a healthy
 * deployment's share on its own (D17). With no seeds connected — the default —
 * the verdict is `insufficient_data` and the controller HOLDS (D10).
 */
export const getGateVerdict = internalQuery({
	args: {
		organizationId: v.string(),
		now: v.number(),
		deferralGateBreached: v.boolean(),
		bounceGateBreached: v.boolean(),
	},
	handler: async (ctx, args): Promise<SeedGateResult & { seedAccountCount: number }> => {
		const summary = await summarizeSeedPlacementWindow(ctx.db, args.organizationId, args.now);
		const result = evaluateSeedPlacementGate({
			rollups: summary.rollups,
			corroboration: {
				deferralGateBreached: args.deferralGateBreached,
				bounceGateBreached: args.bounceGateBreached,
			},
		});
		return { ...result, seedAccountCount: summary.seedAccountCount };
	},
});
