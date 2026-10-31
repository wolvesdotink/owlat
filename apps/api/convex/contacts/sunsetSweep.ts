/**
 * The sunset SWEEP — the hourly cron that converges the book. The per-contact
 * decision lives in `sunsetPolicy.ts` (pure), the batch's own decisions (its
 * bounds, the clock state, the chain and the summary) in
 * `sunsetSweepDecision.ts` (pure), the per-contact reads and writes in
 * `sunsetEngine.ts`, the operator surface in `sunset.ts`; this file is only
 * the bounded scan that loads, calls them and applies what they return.
 *
 * THE SWEEP IS A BOUNDED, RESUMABLE SCAN — never a full-table walk. It ranges
 * the `contacts.by_sunset_evaluated_at` index for rows whose stamp is older
 * than `SUNSET_STALE_MS` (never-evaluated rows sort first, because a missing
 * field precedes every number in a Convex index), takes a fixed batch, stamps
 * every row it looks at, and chains itself while a batch budget remains. The
 * stamp IS the cursor: an evaluated contact leaves the range, so a settled
 * contact is not rescanned until it goes stale again. This is the same shape as
 * the engagement-score backfill (`analytics/engagementScoreSync.ts`) on
 * purpose — one proven pattern, not two.
 */

import { v } from 'convex/values';
import type { MutationCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import { recordAuditLog } from '../lib/auditLog';
import { logWarn } from '../lib/runtimeLog';
import {
	evaluateAndApplySunset,
	globalSunsetPolicyRow,
	sunsetCorroboratingInstant,
	loadSunsetPolicyRows,
	resolveSunsetPolicyForContact,
	type SunsetPolicyRow,
} from './sunsetEngine';
import { isClockCorroborated, type SunsetClock } from './sunsetPolicy';
import {
	CLOCK_SKEWED_RESULT,
	EMPTY_TALLY,
	STALL_LOG_MESSAGE,
	SUNSET_STALE_MS,
	canSuppressMore,
	decideClockStateWrite,
	decideSweepEnd,
	stallSummaryDetails,
	sweepBounds,
	tallyContact,
	wasStallReported,
	type ContactOutcome,
} from './sunsetSweepDecision';

// Re-exported for existing importers; the bounds live with the decisions.
export {
	SUNSET_BATCH_SIZE,
	SUNSET_CONTACTS_PER_TICK,
	SUNSET_STALE_MS,
} from './sunsetSweepDecision';

/** Apply `decideClockStateWrite` to the deployment-wide policy row. */
async function recordSweepClockState(
	ctx: MutationCtx,
	args: { policyRows: readonly SunsetPolicyRow[]; now: number; isStalled: boolean }
): Promise<void> {
	const existing = globalSunsetPolicyRow(args.policyRows);
	const write = decideClockStateWrite(existing, args.now, args.isStalled);
	if (write.kind === 'insert') await ctx.db.insert('sunsetPolicies', write.row);
	if (write.kind === 'patch' && existing) await ctx.db.patch(existing._id, write.patch);
}

const SUMMARY_LOG = {
	userId: 'system',
	action: 'contact.sunset_sweep_summary',
	resource: 'settings',
	resourceId: 'sunset_sweep',
} as const;

// ─── The sweep ──────────────────────────────────────────────────────────────

/**
 * Evaluate the stalest contacts against their resolved sunset policy.
 *
 * `batchSize` is caller-supplied only so tests can shrink it, and is CLAMPED to
 * `SUNSET_BATCH_SIZE` — the clamp is what keeps a single transaction inside the
 * read budget, and a throw here would wedge the chain permanently (the rollback
 * would re-present the identical head next tick).
 */
export const sweepSunsetPolicy = internalMutation({
	args: {
		batchesRemaining: v.optional(v.number()),
		batchSize: v.optional(v.number()),
		/** Suppressions already applied earlier in THIS tick's chain. */
		suppressedSoFar: v.optional(v.number()),
		/**
		 * Caller-supplied only so tests can SHRINK the ceiling, and clamped to
		 * `SUNSET_MAX_SUPPRESSIONS_PER_TICK` — exactly like `batchSize`. A caller
		 * can never raise the bound, only lower it.
		 */
		maxSuppressions: v.optional(v.number()),
		/**
		 * The tick's second reading of time (see `SunsetClock`), computed ONCE at
		 * the head of the chain and carried down. Recomputing it per batch would be self-defeating: the
		 * previous batch stamped its rows with the (possibly wrong) `now`, so batch
		 * two would be corroborating this clock against itself.
		 */
		corroboratingInstant: v.optional(v.number()),
	},
	returns: v.object({
		scanned: v.number(),
		reengaged: v.number(),
		suppressed: v.number(),
		resumed: v.number(),
		/** Suppress verdicts refused by the per-tick ceiling; retried next tick. */
		deferredSuppressions: v.number(),
		isDone: v.boolean(),
		isBudgetExhausted: v.boolean(),
		isSuppressionCeilingHit: v.boolean(),
		/** The tick aborted before evaluating anything: `now` was not corroborated. */
		isClockSkewed: v.boolean(),
	}),
	handler: async (ctx, args) => {
		const now = Date.now();
		const bounds = sweepBounds(args);

		// THE SECOND READING OF TIME (see `SunsetClock`): the heartbeat the last
		// PASSING tick stamped on the deployment-wide policy row, or the
		// operator's re-arm stamp from `confirmSunsetClock` when that is later
		// (the sweep is the only heartbeat writer, so without it a deployment
		// paused past the tolerance could never run again). Derived by
		// `sunsetCorroboratingInstant`, the same derivation `getSunsetPolicies`
		// reports the stall from, so the screen and the engine cannot disagree.
		const policyRows = await loadSunsetPolicyRows(ctx);
		// ONLY THE HEAD OF THE CHAIN reads and writes the clock state. Later batches
		// carry the head's reading in `corroboratingInstant`, so they neither
		// re-derive it (which would now see the head's own heartbeat and trivially
		// corroborate itself) nor re-stamp the shared row once per batch.
		const isHeadOfChain = args.corroboratingInstant === undefined;
		const corroboratingInstant =
			args.corroboratingInstant ?? sunsetCorroboratingInstant(policyRows);
		const clock: SunsetClock = {
			now,
			...(corroboratingInstant !== undefined ? { corroboratingInstant } : {}),
		};

		// THE SKEW CHECK IS A HEAD-OF-TICK ABORT, decided before any write: the
		// sweep's own heartbeat IS the corroboration source, so a tick that
		// advanced it (or any contact's stamp) to a suspect `now` would let the
		// next tick read its own write back and conclude the clock is fine. On
		// failure the refusal is stored (the heartbeat is left alone) and every
		// later tick re-detects the skew until an operator fixes the clock.
		if (!isClockCorroborated(now, corroboratingInstant)) {
			if (isHeadOfChain) {
				await recordSweepClockState(ctx, { policyRows, now, isStalled: true });
			}
			const lastSummary = await ctx.db
				.query('auditLogs')
				.withIndex('by_action', (q) => q.eq('action', 'contact.sunset_sweep_summary'))
				.order('desc')
				.first();
			if (!wasStallReported(lastSummary, now)) {
				logWarn(STALL_LOG_MESSAGE);
				await recordAuditLog(ctx, {
					...SUMMARY_LOG,
					details: stallSummaryDetails(bounds.maxSuppressions),
				});
			}
			return CLOCK_SKEWED_RESULT;
		}

		// THE HEARTBEAT IS STAMPED BEFORE ANY CONTACT IS TOUCHED: it records that
		// this tick's reading of the clock was corroborated, not how much work
		// followed, so a quiet deployment does not stall itself.
		if (isHeadOfChain) {
			await recordSweepClockState(ctx, { policyRows, now, isStalled: false });
		}

		const candidates = await ctx.db
			.query('contacts')
			.withIndex('by_sunset_evaluated_at', (q) => q.lt('sunsetEvaluatedAt', now - SUNSET_STALE_MS))
			.order('asc')
			.take(bounds.batchSize);

		let tally = EMPTY_TALLY;
		for (const contact of candidates) {
			// Stamp FIRST, unconditionally: a soft-deleted row (or any row we then
			// decide to skip) must still leave the range, or it pins the head of the
			// scan forever and the sweep never advances.
			const previousEvaluatedAt = contact.sunsetEvaluatedAt;
			await ctx.db.patch(contact._id, { sunsetEvaluatedAt: now });
			let outcome: ContactOutcome = { kind: 'deleted' };
			if (contact.deletedAt === undefined) {
				const policy = await resolveSunsetPolicyForContact(ctx, contact._id, policyRows);
				const transition = await evaluateAndApplySunset(ctx, {
					contact,
					policy,
					clock,
					canSuppress: canSuppressMore(bounds, tally),
				});
				outcome = { kind: 'evaluated', ...transition };
			}
			const step = tallyContact(tally, outcome);
			tally = step.tally;
			if (step.restoreStamp) {
				await ctx.db.patch(contact._id, { sunsetEvaluatedAt: previousEvaluatedAt });
			}
			if (step.stop) break;
		}

		const end = decideSweepEnd({
			bounds,
			tally,
			candidateCount: candidates.length,
			corroboratingInstant,
			now,
		});
		if (end.next) {
			await ctx.scheduler.runAfter(0, internal.contacts.sunsetSweep.sweepSunsetPolicy, end.next);
		}
		for (const warning of end.warnings) logWarn(warning);
		if (end.summary) await recordAuditLog(ctx, { ...SUMMARY_LOG, details: end.summary });
		return end.result;
	},
});
