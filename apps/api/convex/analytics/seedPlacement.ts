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
 * SECURITY. Seed credentials are the SAME sealed envelope every other external
 * account uses; this module never reads, returns, or logs them. Seed mailbox
 * CONTENTS are never read into Convex — the poller reports a folder NAME and
 * nothing else. Only `toSeedAccountLogView` output is ever safe to log.
 */

import { v } from 'convex/values';
import { internal } from '../_generated/api';
import { internalMutation, internalQuery, type DatabaseReader } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import {
	classifySeedFolder,
	evaluateSeedPlacementGate,
	planSeedHygiene,
	SEED_ACCOUNTS_PER_ORG_LIMIT,
	shouldRemindSeedRotation,
	summarizeSeedPlacement,
	type SeedGateResult,
	type SeedObservation,
	type SeedProviderRollup,
} from '@owlat/shared/seedPlacement';
import type { DestinationProviderKey } from '@owlat/shared/deliverabilityRouting';
import { takeLiveSeedAccounts } from '../mail/externalAccountShared';

/** Rolling window the roll-up reads. Short enough that a collapse shows up fast. */
export const SEED_PLACEMENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// ── The module's bounds, grouped: every page size and horizon in one place, so
// the ledger's cost profile can be read without walking the file.

/** Hard page bound — the ledger is never `.collect()`ed (D16). */
const SEED_PROBE_SCAN_LIMIT = 500;

/** Rows a single cleanup pass deletes before rescheduling itself. */
const SEED_PROBE_CLEANUP_BATCH = 200;

/** Rows one abandonment pass writes off before rescheduling itself. */
const SEED_PROBE_ABANDON_BATCH = 200;

/**
 * How long a probe may sit un-dispatched before it is written off. Generous on
 * purpose: a warming-capped deployment can hold a campaign page in the
 * workpool for many hours, and a probe that eventually goes out is a perfectly
 * good observation.
 */
export const SEED_PROBE_DISPATCH_HORIZON_MS = 48 * 60 * 60 * 1000;

// ============ SEED ACCOUNTS ============

/**
 * The seed mailboxes of an org. Projection is deliberate: no ciphertext, no
 * IV, no auth tag, no username, no host — a seed account's credentials never
 * leave the sealed envelope the mail-sync worker already owns.
 */
export interface SeedAccountView {
	accountId: Id<'externalMailAccounts'>;
	provider: DestinationProviderKey;
	address: string;
	connectedAt: number;
	rotationReminderDue: boolean;
}

function toSeedAccountView(
	account: Doc<'externalMailAccounts'>,
	address: string,
	now: number
): SeedAccountView {
	return {
		accountId: account._id,
		provider: account.seedProvider ?? 'other',
		address,
		connectedAt: account.createdAt,
		rotationReminderDue: shouldRemindSeedRotation({
			connectedAt: account.createdAt,
			lastRemindedAt: account.seedRotationRemindedAt,
			now,
		}),
	};
}

export async function loadSeedAccounts(
	db: DatabaseReader,
	organizationId: string,
	now: number
): Promise<SeedAccountView[]> {
	// NOT a silent truncation: `mail/externalAccountsSeed.ts` refuses the
	// (limit+1)th LIVE seed at CONNECT time and this read selects the same LIVE
	// rows through the same index, so the page can only ever be short of the cap.
	// A seed the operator connected is always measured.
	const live = await takeLiveSeedAccounts(db, organizationId, SEED_ACCOUNTS_PER_ORG_LIMIT);
	const views: SeedAccountView[] = [];
	for (const row of live) {
		// `imapUsername` is the LOGIN, which for several providers is not an email
		// address at all. The deliverable address is the linked mailbox's.
		const mailbox = await db.get(row.mailboxId);
		if (!mailbox) continue;
		views.push(toSeedAccountView(row, mailbox.address, now));
	}
	return views;
}

/**
 * Record that the operator has been nudged to rotate a stale seed. A reminder
 * is advisory: it never blocks a send, a promotion, or a screen.
 */
export const markSeedRotationReminded = internalMutation({
	args: {
		organizationId: v.string(),
		accountId: v.id('externalMailAccounts'),
		now: v.number(),
	},
	handler: async (ctx, args) => {
		const account = await ctx.db.get(args.accountId);
		if (!account || account.purpose !== 'seed') return { updated: false };
		// Defense in depth at the poller boundary: an org may only ever touch its
		// own seed accounts, even through an internal function.
		if (account.organizationId !== args.organizationId) return { updated: false };
		await ctx.db.patch(args.accountId, {
			seedRotationRemindedAt: args.now,
			updatedAt: args.now,
		});
		return { updated: true };
	},
});

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
		now: v.number(),
		/** Uniform [0,1) draw for the occasional click. Randomness stays at the edge. */
		clickRoll: v.number(),
	},
	handler: async (ctx, args) => {
		const probe = await ctx.db
			.query('seedPlacementProbes')
			.withIndex('by_probe_id', (q) => q.eq('probeId', args.probeId))
			.unique();
		// EVERY failure branch names its reason: the mail-sync worker has to be
		// able to tell "not yours" (a bug in the sweep's org scoping — loud) from
		// "gone" (the retention cleanup won the race — expected, drop it).
		if (!probe) return { recorded: false as const, reason: 'unknown_probe' as const };
		// Defense in depth at the poller boundary.
		if (probe.organizationId !== args.organizationId) {
			return { recorded: false as const, reason: 'foreign_organization' as const };
		}
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

		const classification = classifySeedFolder(args.folderName, probe.provider);
		const hygiene = planSeedHygiene({
			placement: classification.placement,
			alreadyMarkedRead: probe.markedReadAt !== undefined,
			alreadyClicked: probe.clickedAt !== undefined,
			clickRoll: args.clickRoll,
		});

		await ctx.db.patch(probe._id, {
			placement: classification.placement,
			classifiedAt: args.now,
			...(args.folderName !== null ? { folderName: args.folderName } : {}),
			...(classification.categoryLabel !== undefined
				? { categoryLabel: classification.categoryLabel }
				: {}),
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
		const probe = await ctx.db.get(args.probeRef);
		if (!probe) return { recorded: false as const, reason: 'unknown_probe' as const };
		// Same defense in depth as its two siblings: a probe row is only ever
		// writable through the organization that owns it.
		if (probe.organizationId !== args.organizationId) {
			return { recorded: false as const, reason: 'foreign_organization' as const };
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
		const probe = await ctx.db
			.query('seedPlacementProbes')
			.withIndex('by_probe_id', (q) => q.eq('probeId', args.probeId))
			.unique();
		if (!probe) return { recorded: false as const, reason: 'unknown_probe' as const };
		if (probe.unsubscribedAt !== undefined) {
			return { recorded: false as const, reason: 'already_recorded' as const };
		}
		// The same org boundary its three siblings hold. The caller's claim here is
		// the SIGNED one-click token, which carries the organization alongside the
		// probe id precisely so this assertion has something independent to check
		// rather than reading the answer off the row it is about to write.
		if (probe.organizationId !== args.organizationId) {
			return { recorded: false as const, reason: 'foreign_organization' as const };
		}
		await ctx.db.patch(probe._id, { unsubscribedAt: args.now });
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
		observations.push({ provider: probe.provider, placement });
	}

	const accounts = await loadSeedAccounts(db, organizationId, now);
	return {
		rollups: summarizeSeedPlacement(observations),
		seedAccountCount: accounts.length,
		rotationRemindersDue: accounts.filter((a) => a.rotationReminderDue).length,
		windowStart,
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

// ============ BATCHED LEDGER SWEEPS ============

/**
 * Run one bounded pass of a self-rescheduling ledger sweep.
 *
 * Both sweeps below have the identical shape — take a page off an index, apply
 * a per-row write that REMOVES the row from that index's range, and reschedule
 * immediately while the page came back full — so the shape lives here once.
 * "The write leaves the range" is the invariant that makes the recursion
 * terminate; a sweep whose write left the row in range would spin forever.
 */
async function sweepSeedProbeLedger<T>(options: {
	page: () => Promise<T[]>;
	apply: (row: T) => Promise<void>;
	batch: number;
	/** Re-run this sweep immediately; called only when the page came back full. */
	reschedule: () => Promise<void>;
}): Promise<{ processed: number; hasMore: boolean }> {
	const rows = await options.page();
	for (const row of rows) await options.apply(row);
	const hasMore = rows.length === options.batch;
	if (hasMore) await options.reschedule();
	return { processed: rows.length, hasMore };
}

// ============ THE NEVER-DISPATCHED DISPOSITION ============

/**
 * Write off probes that were enqueued but never handed to a transport.
 *
 * They are given their OWN disposition rather than a placement: `missing` means
 * "the provider accepted it and we cannot find it", which is gate 5's most
 * alarming reading, and an undelivered probe means nothing of the sort. Worse,
 * the thing that stops a probe being dispatched — deferrals, warming caps — is
 * the very thing that breaches the corroborating deferral gate, so classifying
 * these as `missing` would let gate 5 reach `fail` on an artifact of our own
 * queue. Written off, they are simply not evidence, in either direction.
 */
export const abandonUndispatchedSeedProbes = internalMutation({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();
		// Every row this patches LEAVES the index range, so the next pass sees new
		// rows — the termination invariant `sweepSeedProbeLedger` documents.
		const { processed, hasMore } = await sweepSeedProbeLedger({
			batch: SEED_PROBE_ABANDON_BATCH,
			reschedule: async () => {
				await ctx.scheduler.runAfter(
					0,
					internal.analytics.seedPlacement.abandonUndispatchedSeedProbes,
					{}
				);
			},
			page: () =>
				ctx.db
					.query('seedPlacementProbes')
					.withIndex('by_undispatched_watch', (q) =>
						q
							.eq('notDispatchedAt', undefined)
							.eq('dispatchedAt', undefined)
							.lte('sentAt', now - SEED_PROBE_DISPATCH_HORIZON_MS)
					)
					.take(SEED_PROBE_ABANDON_BATCH),
			apply: async (probe) => {
				await ctx.db.patch(probe._id, { notDispatchedAt: now });
			},
		});
		return { abandoned: processed, hasMore };
	},
});

// ============ RETENTION ============

/** Cleanup cron — the probe ledger is retention-bounded (D16). */
export const deleteExpiredSeedProbes = internalMutation({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();
		// A full batch means there is more to drop. Continue immediately rather
		// than waiting 24h — ten seeds x twenty campaigns a day outpaces a single
		// bounded pass, and an unbounded ledger is not "retention-bounded" (D16).
		// Same self-rescheduling idiom as `webhooks/cleanup.ts`.
		const { processed, hasMore } = await sweepSeedProbeLedger({
			batch: SEED_PROBE_CLEANUP_BATCH,
			reschedule: async () => {
				await ctx.scheduler.runAfter(
					0,
					internal.analytics.seedPlacement.deleteExpiredSeedProbes,
					{}
				);
			},
			page: () =>
				ctx.db
					.query('seedPlacementProbes')
					.withIndex('by_expires_at', (q) => q.lte('expiresAt', now))
					.take(SEED_PROBE_CLEANUP_BATCH),
			apply: async (row) => {
				await ctx.db.delete(row._id);
			},
		});
		return { deleted: processed, hasMore };
	},
});
