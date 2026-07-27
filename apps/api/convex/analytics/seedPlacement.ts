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
	shouldRemindSeedRotation,
	summarizeSeedPlacement,
	type SeedGateResult,
	type SeedObservation,
	type SeedProviderRollup,
} from '@owlat/shared/seedPlacement';
import type { DestinationProviderKey } from '@owlat/shared/deliverabilityRouting';

/** Rolling window the roll-up reads. Short enough that a collapse shows up fast. */
export const SEED_PLACEMENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Hard page bound — the ledger is never `.collect()`ed (D16). */
const SEED_PROBE_SCAN_LIMIT = 500;

/** Rows a single cleanup pass deletes before rescheduling itself. */
const SEED_PROBE_CLEANUP_BATCH = 200;

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
	const rows = await db
		.query('externalMailAccounts')
		.withIndex('by_org_and_purpose', (q) =>
			q.eq('organizationId', organizationId).eq('purpose', 'seed')
		)
		.take(50);
	const live = rows.filter((row) => row.status !== 'disconnected');
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

export const listSeedAccounts = internalQuery({
	args: { organizationId: v.string(), now: v.number() },
	handler: async (ctx, args): Promise<SeedAccountView[]> =>
		loadSeedAccounts(ctx.db, args.organizationId, args.now),
});

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
		if (!probe) return { recorded: false as const };
		// Defense in depth at the poller boundary.
		if (probe.organizationId !== args.organizationId) return { recorded: false as const };
		// A probe we never handed to a transport is NOT evidence — it was never
		// mailed, so no folder is the right answer and `missing` is the wrong one.
		// The work selection already excludes it; this is the load-bearing check,
		// because `missing` is the outcome that feeds the collapse tripwire and it
		// must never be manufactured by our own queue.
		if (probe.dispatchedAt === undefined) {
			return { recorded: false as const, reason: 'never_dispatched' as const };
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
		if (!probe) return { recorded: false };
		// Same defense in depth as its two siblings: a probe row is only ever
		// writable through the organization that owns it.
		if (probe.organizationId !== args.organizationId) return { recorded: false };
		await ctx.db.patch(args.probeRef, {
			transportArm: args.transportArm,
			dispatchedAt: args.now,
		});
		return { recorded: true };
	},
});

/**
 * The probe's RFC 8058 one-click target was exercised. There is no contact to
 * unsubscribe — this only timestamps the probe row, so the operator can see
 * that the seed's one-click endpoint really works end to end.
 */
export const recordSeedProbeUnsubscribe = internalMutation({
	args: { probeId: v.string(), now: v.number() },
	handler: async (ctx, args) => {
		const probe = await ctx.db
			.query('seedPlacementProbes')
			.withIndex('by_probe_id', (q) => q.eq('probeId', args.probeId))
			.unique();
		if (!probe || probe.unsubscribedAt !== undefined) return { recorded: false };
		await ctx.db.patch(probe._id, { unsubscribedAt: args.now });
		return { recorded: true };
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

// ============ THE NEVER-DISPATCHED DISPOSITION ============

/**
 * How long a probe may sit un-dispatched before it is written off. Generous on
 * purpose: a warming-capped deployment can hold a campaign page in the
 * workpool for many hours, and a probe that eventually goes out is a perfectly
 * good observation.
 */
export const SEED_PROBE_DISPATCH_HORIZON_MS = 48 * 60 * 60 * 1000;

/** Rows one abandonment pass writes off before rescheduling itself. */
const SEED_PROBE_ABANDON_BATCH = 200;

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
		const stale = await ctx.db
			.query('seedPlacementProbes')
			.withIndex('by_undispatched_watch', (q) =>
				q
					.eq('notDispatchedAt', undefined)
					.eq('dispatchedAt', undefined)
					.lte('sentAt', now - SEED_PROBE_DISPATCH_HORIZON_MS)
			)
			.take(SEED_PROBE_ABANDON_BATCH);
		for (const probe of stale) {
			await ctx.db.patch(probe._id, { notDispatchedAt: now });
		}
		const abandoned = stale.length;
		// A full batch means there is more to write off, and every row just
		// patched has LEFT the index range, so the next pass sees new rows.
		const hasMore = abandoned === SEED_PROBE_ABANDON_BATCH;
		if (hasMore) {
			await ctx.scheduler.runAfter(
				0,
				internal.analytics.seedPlacement.abandonUndispatchedSeedProbes,
				{}
			);
		}
		return { abandoned, hasMore };
	},
});

// ============ RETENTION ============

/** Cleanup cron — the probe ledger is retention-bounded (D16). */
export const deleteExpiredSeedProbes = internalMutation({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();
		const expired = await ctx.db
			.query('seedPlacementProbes')
			.withIndex('by_expires_at', (q) => q.lte('expiresAt', now))
			.take(SEED_PROBE_CLEANUP_BATCH);
		for (const row of expired) {
			await ctx.db.delete(row._id);
		}
		// A full batch means there is more to drop. Continue immediately rather
		// than waiting 24h — ten seeds x twenty campaigns a day outpaces a single
		// bounded pass, and an unbounded ledger is not "retention-bounded" (D16).
		// Same self-rescheduling idiom as `webhooks/cleanup.ts`.
		if (expired.length === SEED_PROBE_CLEANUP_BATCH) {
			await ctx.scheduler.runAfter(0, internal.analytics.seedPlacement.deleteExpiredSeedProbes, {});
		}
		return { deleted: expired.length, hasMore: expired.length === SEED_PROBE_CLEANUP_BATCH };
	},
});
