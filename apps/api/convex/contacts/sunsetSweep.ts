/**
 * The sunset SWEEP — the hourly cron that converges the book (deliverability
 * plan P4-4). The decision lives in `sunsetPolicy.ts` (pure), the per-contact
 * reads and writes in `sunsetEngine.ts`, the operator surface in `sunset.ts`;
 * this file is only the bounded scan around them.
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
import { internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';
import { recordAuditLog } from '../lib/auditLog';
import { logWarn } from '../lib/runtimeLog';
import {
	evaluateAndApplySunset,
	loadSunsetPolicyRows,
	resolveSunsetPolicyForContact,
} from './sunsetEngine';

/** A contact is re-evaluated at most once a day. */
export const SUNSET_STALE_MS = 24 * 60 * 60 * 1000;

/** Contacts inspected per transaction. Keeps one batch inside the read budget. */
export const SUNSET_BATCH_SIZE = 50;

/** Chained batches per tick — the hard ceiling on one sweep's work. */
export const SUNSET_MAX_BATCHES = 20;

/**
 * Contacts one tick can converge: 50 x 20 = 1000.
 *
 * THROUGHPUT. The cron runs HOURLY, so the sustained ceiling is ~24,000
 * contacts a day while `SUNSET_STALE_MS` still guarantees any one contact is
 * evaluated at most once a day. A daily cron would have capped the whole
 * deployment at 1000 contacts a day: past that the stale range never drains,
 * every tick logs the budget warning, and a contact quiet past the suppression
 * window is acted on days late.
 */
export const SUNSET_CONTACTS_PER_TICK = SUNSET_BATCH_SIZE * SUNSET_MAX_BATCHES;

/**
 * THE BLAST-RADIUS CEILING: how many contacts ONE tick may auto-suppress.
 *
 * The engine's per-contact guards are all about whether THIS contact is quiet.
 * None of them can notice that the answer has suddenly become "yes" for the
 * entire book at once, which is what a jumped clock, a bad import that
 * back-dates every activity, or a mis-saved policy all look like. This is the
 * bound on that whole CLASS of mistake: past it the tick stops suppressing,
 * stops chaining, records what it refused, and lets the next hour retry.
 *
 * 100 of a 1000-contact tick — deliberately well below the tick's capacity, so a
 * systemic mis-evaluation is caught in the first tick rather than the tenth. A
 * genuine backlog (a real book that really is that quiet) drains at 100 an hour
 * with an audit trail at every step, which is the pace this decision deserves.
 */
export const SUNSET_MAX_SUPPRESSIONS_PER_TICK = 100;

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
		 * The tick's second reading of time, computed ONCE at the head of the chain
		 * and carried down. Recomputing it per batch would be self-defeating: the
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
	}),
	handler: async (ctx, args) => {
		const now = Date.now();
		const staleBefore = now - SUNSET_STALE_MS;
		const batchSize = Math.max(1, Math.min(args.batchSize ?? SUNSET_BATCH_SIZE, SUNSET_BATCH_SIZE));
		const batchesRemaining = Math.max(
			0,
			Math.min(args.batchesRemaining ?? SUNSET_MAX_BATCHES, SUNSET_MAX_BATCHES)
		);
		const suppressedSoFar = Math.max(0, args.suppressedSoFar ?? 0);
		const maxSuppressions = Math.max(
			0,
			Math.min(
				args.maxSuppressions ?? SUNSET_MAX_SUPPRESSIONS_PER_TICK,
				SUNSET_MAX_SUPPRESSIONS_PER_TICK
			)
		);

		const candidates = await ctx.db
			.query('contacts')
			.withIndex('by_sunset_evaluated_at', (q) => q.lt('sunsetEvaluatedAt', staleBefore))
			.order('asc')
			.take(batchSize);

		// THE SECOND READING OF TIME (see `SunsetFacts.corroboratingInstant`): the
		// freshest evaluation stamp in the table, written by an earlier tick under
		// an earlier reading of the clock. Same index, opposite end, one row — so
		// the guard against a jumped host clock costs a single point read per
		// batch. Absent on a deployment that has never swept, which is exactly the
		// case the ceiling below covers instead.
		const newestEvaluated =
			args.corroboratingInstant === undefined
				? await ctx.db.query('contacts').withIndex('by_sunset_evaluated_at').order('desc').first()
				: null;
		const corroboratingInstant = args.corroboratingInstant ?? newestEvaluated?.sunsetEvaluatedAt;

		const policyRows = await loadSunsetPolicyRows(ctx);

		let scanned = 0;
		let reengaged = 0;
		let suppressed = 0;
		let resumed = 0;
		let deferredSuppressions = 0;
		let isSuppressionCeilingHit = false;

		for (const contact of candidates) {
			scanned += 1;
			// Stamp FIRST, unconditionally: a soft-deleted row (or any row we then
			// decide to skip) must still leave the range, or it pins the head of the
			// scan forever and the sweep never advances.
			const previousEvaluatedAt = contact.sunsetEvaluatedAt;
			await ctx.db.patch(contact._id, { sunsetEvaluatedAt: now });
			if (contact.deletedAt !== undefined) continue;

			const policy = await resolveSunsetPolicyForContact(ctx, contact._id, policyRows);
			const { verdict, applied, deferred } = await evaluateAndApplySunset(ctx, {
				contact,
				policy,
				now,
				...(corroboratingInstant !== undefined ? { corroboratingInstant } : {}),
				canSuppress: suppressedSoFar + suppressed < maxSuppressions,
			});

			if (deferred) {
				// Put the contact BACK in the stale range — it was not settled, it was
				// refused, and the next tick must be able to reach it. Then stop: the
				// ceiling applies to the whole tick, so there is nothing left for this
				// chain to do that it is allowed to do.
				await ctx.db.patch(contact._id, { sunsetEvaluatedAt: previousEvaluatedAt });
				deferredSuppressions += 1;
				isSuppressionCeilingHit = true;
				break;
			}

			if (!applied) continue;
			if (verdict.action === 'enter_reengagement') reengaged += 1;
			else if (verdict.action === 'suppress') suppressed += 1;
			else if (verdict.action === 'resume') resumed += 1;
		}

		const isDone = !isSuppressionCeilingHit && candidates.length < batchSize;
		const isBudgetExhausted = !isDone && !isSuppressionCeilingHit && batchesRemaining <= 1;
		if (!isDone && !isSuppressionCeilingHit && batchesRemaining > 1) {
			await ctx.scheduler.runAfter(0, internal.contacts.sunsetSweep.sweepSunsetPolicy, {
				batchesRemaining: batchesRemaining - 1,
				batchSize,
				suppressedSoFar: suppressedSoFar + suppressed,
				maxSuppressions,
				...(corroboratingInstant !== undefined ? { corroboratingInstant } : {}),
			});
		}

		if (isBudgetExhausted) {
			// The chain's return value is dropped, so a log line is the only way an
			// operator learns the book is bigger than one tick's capacity.
			logWarn(
				`[sunsetSweep] tick exhausted its ${SUNSET_MAX_BATCHES}-batch budget ` +
					`(~${SUNSET_CONTACTS_PER_TICK} contacts) with stale contacts still queued; ` +
					`contacts re-evaluate on a longer cycle than ${SUNSET_STALE_MS}ms`
			);
		}

		// THE OPERATOR-FACING SUMMARY OF THE TICK. Per-contact rows answer "why was
		// this address suppressed"; this one answers the question nobody can ask a
		// per-contact row — "did the engine just suppress a hundred people, and
		// why". It is written only when the tick actually did something
		// irreversible or refused to, so a quiet deployment writes nothing.
		if (suppressed > 0 || deferredSuppressions > 0) {
			await recordAuditLog(ctx, {
				userId: 'system',
				action: 'contact.sunset_sweep_summary',
				resource: 'settings',
				resourceId: 'sunset_sweep',
				details: {
					actor: 'sunset_engine',
					scanned,
					suppressed,
					reengaged,
					resumed,
					deferredSuppressions,
					suppressionCeiling: maxSuppressions,
					isSuppressionCeilingHit,
					message: isSuppressionCeilingHit
						? `Auto-suppression paused: this sweep reached its ceiling of ` +
							`${maxSuppressions} suppressions. Review the suppressed ` +
							`contacts and the sunset policy before the next hourly sweep resumes; ` +
							`restore any contact from the suppression list in one action.`
						: `${suppressed} contact(s) auto-suppressed after the configured quiet ` +
							`window. Review or restore them from the suppression list.`,
				},
			});
		}

		if (isSuppressionCeilingHit) {
			logWarn(
				`[sunsetSweep] suppression ceiling of ${maxSuppressions} reached; ` +
					`stopped this tick with ${deferredSuppressions} suppression(s) deferred`
			);
		}

		return {
			scanned,
			reengaged,
			suppressed,
			resumed,
			deferredSuppressions,
			isDone,
			isBudgetExhausted,
			isSuppressionCeilingHit,
		};
	},
});
