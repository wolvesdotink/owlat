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
import { isClockCorroborated, latestSunsetInstant, MS_PER_DAY } from './sunsetPolicy';

/** A contact is re-evaluated at most once a day. */
export const SUNSET_STALE_MS = MS_PER_DAY;

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

/**
 * ONE statement of how a caller-supplied bound is coerced. THE TWO FAILURE
 * MODES ARE DIFFERENT AND MUST NOT BE COLLAPSED:
 *
 *  - ABSENT (`undefined`) is the ORDINARY case — the hourly cron calls this
 *    mutation with no arguments at all — and means "use the argument's true
 *    default". Substituting a *safe* value here would be catastrophic for
 *    `suppressedSoFar`, whose safe value is the ceiling: every first tick would
 *    start with the budget already spent and the engine would suppress nothing,
 *    forever, while reporting a ceiling hit.
 *  - UNREADABLE (present but not a finite number) is the adversarial case and
 *    takes the SAFE value: `Math.min(NaN, n)` is `NaN`, and a `NaN` batch size
 *    reaches `.take()` as undefined behaviour inside a mutation that must not
 *    throw (a rollback here re-presents the identical head next tick and wedges
 *    the chain permanently); an unreadable count of what earlier batches already
 *    suppressed must read as "budget spent", never as "none".
 *
 * Stated once so the four bounds cannot drift.
 */
function clampArg(
	value: number | undefined,
	whenAbsent: number,
	whenUnreadable: number,
	min: number,
	max: number
): number {
	if (value === undefined) return whenAbsent;
	if (!Number.isFinite(value)) return whenUnreadable;
	return Math.max(min, Math.min(value, max));
}

/**
 * How often a PERSISTENT clock stall is re-reported. The stall is a condition
 * an operator has to clear, and an hourly cron would otherwise write the same
 * audit row 24 times a day for as long as it lasts — which buries the rest of
 * the audit trail under a message that says nothing new. The first tick to
 * notice always reports; after that, once a day.
 */
const SUNSET_STALL_REPORT_INTERVAL_MS = MS_PER_DAY;

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
		/** The tick aborted before evaluating anything: `now` was not corroborated. */
		isClockSkewed: v.boolean(),
	}),
	handler: async (ctx, args) => {
		const now = Date.now();
		const staleBefore = now - SUNSET_STALE_MS;
		const batchSize = clampArg(
			args.batchSize,
			SUNSET_BATCH_SIZE,
			SUNSET_BATCH_SIZE,
			1,
			SUNSET_BATCH_SIZE
		);
		const batchesRemaining = clampArg(
			args.batchesRemaining,
			SUNSET_MAX_BATCHES,
			SUNSET_MAX_BATCHES,
			0,
			SUNSET_MAX_BATCHES
		);
		// ABSENT means this is the HEAD of the chain: nothing has been suppressed
		// yet, so the true default is 0. Only an UNREADABLE value falls back to the
		// ceiling — a count of what earlier batches already did that we cannot read
		// must be treated as "budget spent", never as "none".
		const suppressedSoFar = clampArg(
			args.suppressedSoFar,
			0,
			SUNSET_MAX_SUPPRESSIONS_PER_TICK,
			0,
			SUNSET_MAX_SUPPRESSIONS_PER_TICK
		);
		const maxSuppressions = clampArg(
			args.maxSuppressions,
			SUNSET_MAX_SUPPRESSIONS_PER_TICK,
			SUNSET_MAX_SUPPRESSIONS_PER_TICK,
			0,
			SUNSET_MAX_SUPPRESSIONS_PER_TICK
		);

		// THE SECOND READING OF TIME (see `SunsetFacts.corroboratingInstant`): the
		// freshest evaluation stamp in the table, written by an earlier tick under
		// an earlier reading of the clock. Same index, opposite end, one row — so
		// the guard against a jumped host clock costs a single point read per
		// batch. Absent on a deployment that has never swept, which is exactly the
		// case the blast-radius ceiling covers instead.
		//
		// THE OPERATOR'S RE-ARM STAMP IS A SECOND SOURCE, and it is what stops this
		// guard from latching on forever. The sweep is the ONLY writer of the
		// evaluation stamps, so a deployment paused for longer than the tolerance
		// could never refresh them by itself: no tick would run, so no stamp would
		// be written, so no tick would ever run again. `confirmSunsetClock`
		// (contacts/sunset.ts) lets an operator who has checked the clock record
		// that fact; the LATER of the two readings is what `now` is judged against.
		const policyRows = await loadSunsetPolicyRows(ctx);
		const newestEvaluated =
			args.corroboratingInstant === undefined
				? await ctx.db.query('contacts').withIndex('by_sunset_evaluated_at').order('desc').first()
				: null;
		const corroboratingInstant =
			args.corroboratingInstant ??
			latestSunsetInstant(
				newestEvaluated?.sunsetEvaluatedAt,
				policyRows.find((row) => row.topicId === undefined)?.clockVerifiedAt
			);

		// THE SKEW CHECK IS A HEAD-OF-TICK ABORT, NOT A PER-CONTACT HOLD.
		//
		// It has to be, because the sweep's own freshness stamps ARE the
		// corroboration source. Checking per contact — after the row has already
		// been stamped with the suspect `now` — protects exactly one tick: the
		// next one reads back the stamps this one wrote, finds them an hour old,
		// and concludes the clock is fine. So: decide once, before any write, and
		// on failure return having written NOTHING to `sunsetEvaluatedAt`. The
		// corroboration source stays uncontaminated and every later tick
		// re-detects the same skew until an operator fixes the clock.
		if (!isClockCorroborated(now, corroboratingInstant)) {
			// A PERMANENT CONDITION MUST BE A BOUNDED WRITE PATH. The stall can only
			// be cleared by a person, and the cron runs hourly, so reporting it every
			// tick would write the identical row 24 times a day forever and drown the
			// audit trail. Report the first tick that notices, then once a day.
			const lastSummary = await ctx.db
				.query('auditLogs')
				.withIndex('by_action', (q) => q.eq('action', 'contact.sunset_sweep_summary'))
				.order('desc')
				.first();
			const wasAlreadyReported =
				lastSummary?.details?.['isClockSkewed'] === true &&
				now - lastSummary.createdAt < SUNSET_STALL_REPORT_INTERVAL_MS &&
				lastSummary.createdAt <= now;

			if (!wasAlreadyReported) {
				logWarn(
					`[sunsetSweep] tick aborted: the host clock is not corroborated by the ` +
						`freshest stored evaluation stamp; no contacts were evaluated and nothing ` +
						`was suppressed. Check NTP on this deployment.`
				);
				await recordAuditLog(ctx, {
					userId: 'system',
					action: 'contact.sunset_sweep_summary',
					resource: 'settings',
					resourceId: 'sunset_sweep',
					details: {
						actor: 'sunset_engine',
						scanned: 0,
						suppressed: 0,
						reengaged: 0,
						resumed: 0,
						deferredSuppressions: 0,
						suppressionCeiling: maxSuppressions,
						isSuppressionCeilingHit: false,
						isClockSkewed: true,
						message:
							`Sunset sweep paused: this deployment's clock disagrees with the ` +
							`timestamps it wrote earlier, so no contact was evaluated and none was ` +
							`suppressed. Nothing changed, and nothing will be suppressed until ` +
							`this clears. Check the system clock (NTP); if the clock is correct — ` +
							`a deployment that was simply paused for a long time looks the same ` +
							`from here — confirm it from the sunset policy settings to resume ` +
							`sweeps. This message repeats at most once a day.`,
					},
				});
			}
			return {
				scanned: 0,
				reengaged: 0,
				suppressed: 0,
				resumed: 0,
				deferredSuppressions: 0,
				isDone: false,
				isBudgetExhausted: false,
				isSuppressionCeilingHit: false,
				isClockSkewed: true,
			};
		}

		const candidates = await ctx.db
			.query('contacts')
			.withIndex('by_sunset_evaluated_at', (q) => q.lt('sunsetEvaluatedAt', staleBefore))
			.order('asc')
			.take(batchSize);

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
					// WORDED OFF THE COUNTS, NOT OFF THE FLAG. A tick that suppressed
					// nothing and merely refused one contact must not tell the operator
					// that a hundred suppressions just happened — the ceiling can be hit
					// with zero suppressions in this tick whenever an earlier batch in the
					// same chain spent the budget, or a caller passed a small ceiling.
					message: isSuppressionCeilingHit
						? `${suppressed} contact(s) auto-suppressed after the configured quiet ` +
							`window; ${deferredSuppressions} more were held back because this ` +
							`sweep reached its ceiling of ${maxSuppressions} suppressions ` +
							`(${suppressedSoFar + suppressed} used so far this sweep). The held-back ` +
							`contacts are retried on the next hourly sweep. Review the suppressed ` +
							`contacts and the sunset policy first; any contact can be restored ` +
							`from the suppression list in one action.`
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
			isClockSkewed: false,
		};
	},
});
