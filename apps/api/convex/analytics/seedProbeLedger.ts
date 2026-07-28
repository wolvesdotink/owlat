/**
 * Seed-probe LEDGER housekeeping — the two self-rescheduling sweeps.
 *
 * Split out of `analytics/seedPlacement.ts` for size (CONVENTIONS' ~500 LOC
 * guideline). Neither sweep sends mail, touches a campaign, or can fail a send:
 * both are bounded passes over `seedPlacementProbes`, and with no seed
 * mailboxes connected the ledger is empty and both are no-ops (D2).
 *
 * They are registered from `analytics/cronRegistration.ts`.
 */

import { internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';
import { SEED_PROBE_DISPATCH_HORIZON_MS } from './seedPlacement';

/** Rows a single cleanup pass deletes before rescheduling itself. */
const SEED_PROBE_CLEANUP_BATCH = 200;

/** Rows one abandonment pass writes off before rescheduling itself. */
const SEED_PROBE_ABANDON_BATCH = 200;

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
					internal.analytics.seedProbeLedger.abandonUndispatchedSeedProbes,
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
					internal.analytics.seedProbeLedger.deleteExpiredSeedProbes,
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
