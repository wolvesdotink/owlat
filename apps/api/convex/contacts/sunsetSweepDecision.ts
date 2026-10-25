/**
 * The sunset sweep's decisions, without the database: how a batch's bounds are
 * read from its arguments, what the head of the chain writes on the
 * deployment-wide policy row, whether a clock stall is reported again, how
 * each contact's outcome is counted, and what the batch does when it ends
 * (chain, warn, summarise). `sunsetSweep.ts` loads, calls these and applies the
 * result; the per-contact verdict stays with `sunsetPolicy.ts`.
 *
 * PURE: `now` is a parameter and nothing here reads a clock, a database or the
 * environment (scripts/purity-roots.txt).
 */

import { DAY_MS } from '../lib/constants';
import type { AuditDetails } from '../lib/auditLog';
import type { SunsetVerdict } from './sunsetPolicy';

/** A contact is re-evaluated at most once a day. */
export const SUNSET_STALE_MS = DAY_MS;

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
 * How often a PERSISTENT clock stall is re-reported. The stall is a condition
 * an operator has to clear, and an hourly cron would otherwise write the same
 * audit row 24 times a day for as long as it lasts — which buries the rest of
 * the audit trail under a message that says nothing new. The first tick to
 * notice always reports; after that, once a day.
 */
export const SUNSET_STALL_REPORT_INTERVAL_MS = DAY_MS;

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
function clampArg(options: {
	value: number | undefined;
	whenAbsent: number;
	whenUnreadable: number;
	min: number;
	max: number;
}): number {
	const { value, whenAbsent, whenUnreadable, min, max } = options;
	if (value === undefined) return whenAbsent;
	if (!Number.isFinite(value)) return whenUnreadable;
	return Math.max(min, Math.min(value, max));
}

/** The arguments one batch of the chain is called with. */
export interface SweepArgs {
	readonly batchesRemaining?: number;
	readonly batchSize?: number;
	readonly suppressedSoFar?: number;
	readonly maxSuppressions?: number;
	readonly corroboratingInstant?: number;
}

/** The bounds one batch runs under, every one finite and in range. */
export interface SweepBounds {
	readonly batchSize: number;
	readonly batchesRemaining: number;
	readonly suppressedSoFar: number;
	readonly maxSuppressions: number;
}

/**
 * Read a batch's bounds from its arguments. `batchSize` and `maxSuppressions`
 * can only be lowered by a caller (tests shrink them), never raised.
 */
export function sweepBounds(args: SweepArgs): SweepBounds {
	return {
		batchSize: clampArg({
			value: args.batchSize,
			whenAbsent: SUNSET_BATCH_SIZE,
			whenUnreadable: SUNSET_BATCH_SIZE,
			min: 1,
			max: SUNSET_BATCH_SIZE,
		}),
		batchesRemaining: clampArg({
			value: args.batchesRemaining,
			whenAbsent: SUNSET_MAX_BATCHES,
			whenUnreadable: SUNSET_MAX_BATCHES,
			min: 0,
			max: SUNSET_MAX_BATCHES,
		}),
		// ABSENT means this is the HEAD of the chain: nothing has been suppressed
		// yet, so the true default is 0. Only an UNREADABLE value falls back to the
		// ceiling — a count of what earlier batches already did that we cannot read
		// must be treated as "budget spent", never as "none".
		suppressedSoFar: clampArg({
			value: args.suppressedSoFar,
			whenAbsent: 0,
			whenUnreadable: SUNSET_MAX_SUPPRESSIONS_PER_TICK,
			min: 0,
			max: SUNSET_MAX_SUPPRESSIONS_PER_TICK,
		}),
		maxSuppressions: clampArg({
			value: args.maxSuppressions,
			whenAbsent: SUNSET_MAX_SUPPRESSIONS_PER_TICK,
			whenUnreadable: SUNSET_MAX_SUPPRESSIONS_PER_TICK,
			min: 0,
			max: SUNSET_MAX_SUPPRESSIONS_PER_TICK,
		}),
	};
}

// ─── The clock state on the policy row ──────────────────────────────────────

/** What the head of the chain writes on the deployment-wide policy row. */
export type ClockStateWrite =
	| { readonly kind: 'none' }
	| {
			readonly kind: 'insert';
			readonly row: {
				readonly lastSweepAt?: number;
				readonly clockStalledAt?: number;
				readonly createdAt: number;
				readonly updatedAt: number;
			};
	  }
	| {
			readonly kind: 'patch';
			readonly patch: {
				readonly lastSweepAt?: number;
				readonly clockStalledAt?: number | undefined;
				readonly updatedAt: number;
			};
	  };

/**
 * Record what this tick learned about the clock on the ONE deployment-wide
 * `sunsetPolicies` row: the heartbeat a later tick corroborates its `now`
 * against, and whether the sweep is currently refusing to run.
 *
 * TWO PROPERTIES MAKE THIS SAFE TO APPLY EVERY TICK. Only the head of a chain
 * applies it, so it writes at most once an hour, and it writes NOTHING when the
 * state is unchanged and there is no heartbeat to advance — so the operator
 * query that subscribes to this table is invalidated by the sweep at most
 * hourly, instead of once per contact the sweep re-stamps.
 *
 * The row is created on demand: an install that never tuned a policy has no row
 * at all, and an all-`undefined` override row resolves to exactly the shipped
 * defaults, so materialising it changes no policy.
 */
export function decideClockStateWrite(
	existing: { readonly clockStalledAt?: number | null } | undefined,
	now: number,
	isStalled: boolean
): ClockStateWrite {
	if (existing === undefined) {
		// A TOTAL FUNCTION OF ITS INPUTS, not two speculative cases: today only the
		// healthy branch can reach this, because with no row there is no
		// corroborating instant and a tick with nothing to disagree with never
		// refuses. Branching on `isStalled` anyway keeps the row's meaning correct
		// if that ever stops being true.
		return {
			kind: 'insert',
			row: {
				...(isStalled ? { clockStalledAt: now } : { lastSweepAt: now }),
				createdAt: now,
				updatedAt: now,
			},
		};
	}

	// "Currently stalled" is "an instant is stored" — a type check, not a
	// `!== undefined` one, because a cleared optional can read back as `null`.
	const isCurrentlyStalled = typeof existing.clockStalledAt === 'number';

	if (isStalled) {
		// STAMP THE TRANSITION ONLY. A stall is cleared by a person, so re-stamping
		// it hourly would turn a permanent condition into a permanent write source
		// — and would move the instant, making "since when" unanswerable. The
		// heartbeat is deliberately left where it was: it is the reading this tick
		// just failed to corroborate against, and overwriting it would erase the
		// evidence of the skew.
		if (isCurrentlyStalled) return { kind: 'none' };
		return { kind: 'patch', patch: { clockStalledAt: now, updatedAt: now } };
	}

	return {
		kind: 'patch',
		patch: {
			lastSweepAt: now,
			// Patching an optional field to `undefined` is how Convex clears it.
			...(isCurrentlyStalled ? { clockStalledAt: undefined } : {}),
			updatedAt: now,
		},
	};
}

// ─── A tick that refuses to run ─────────────────────────────────────────────

/**
 * Was the stall already reported within the last report interval? A
 * PERMANENT CONDITION MUST BE A BOUNDED WRITE PATH: the stall can only be
 * cleared by a person and the cron runs hourly, so reporting it every tick
 * would write the identical row 24 times a day forever.
 */
export function wasStallReported(
	lastSummary: { readonly createdAt: number; readonly details?: AuditDetails } | null,
	now: number
): boolean {
	if (lastSummary === null) return false;
	return (
		lastSummary.details?.['isClockSkewed'] === true &&
		now - lastSummary.createdAt < SUNSET_STALL_REPORT_INTERVAL_MS &&
		lastSummary.createdAt <= now
	);
}

export const STALL_LOG_MESSAGE =
	`[sunsetSweep] tick aborted: the host clock is not corroborated by the ` +
	`freshest stored evaluation stamp; no contacts were evaluated and nothing ` +
	`was suppressed. Check NTP on this deployment.`;

/** The audit details of a tick that refused to run on an uncorroborated clock. */
export function stallSummaryDetails(maxSuppressions: number): AuditDetails {
	return {
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
			`from here — run the "contacts/sunset:confirmSunsetClock" mutation ` +
			`(requires contacts:manage) to confirm the clock and resume sweeps; ` +
			`see the "List sunsetting" guide. This message repeats at most once ` +
			`a day.`,
	};
}

/** What one batch reports. */
export interface SweepResult {
	readonly scanned: number;
	readonly reengaged: number;
	readonly suppressed: number;
	readonly resumed: number;
	readonly deferredSuppressions: number;
	readonly isDone: boolean;
	readonly isBudgetExhausted: boolean;
	readonly isSuppressionCeilingHit: boolean;
	readonly isClockSkewed: boolean;
}

export const CLOCK_SKEWED_RESULT: SweepResult = {
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

// ─── The batch ──────────────────────────────────────────────────────────────

/** What a batch has done so far. */
export interface SweepTally {
	readonly scanned: number;
	readonly reengaged: number;
	readonly suppressed: number;
	readonly resumed: number;
	readonly deferredSuppressions: number;
	readonly isSuppressionCeilingHit: boolean;
}

export const EMPTY_TALLY: SweepTally = {
	scanned: 0,
	reengaged: 0,
	suppressed: 0,
	resumed: 0,
	deferredSuppressions: 0,
	isSuppressionCeilingHit: false,
};

/** May the next contact still be suppressed under this tick's ceiling? */
export function canSuppressMore(bounds: SweepBounds, tally: SweepTally): boolean {
	return bounds.suppressedSoFar + tally.suppressed < bounds.maxSuppressions;
}

/** What happened to one contact the batch looked at. */
export type ContactOutcome =
	| { readonly kind: 'deleted' }
	| {
			readonly kind: 'evaluated';
			readonly verdict: Pick<SunsetVerdict, 'action'>;
			readonly applied: boolean;
			readonly deferred: boolean;
	  };

/**
 * Count one contact, and say what the batch does next: `restoreStamp` puts a
 * refused contact BACK in the stale range (it was not settled, it was refused,
 * and the next tick must reach it), and `stop` ends the batch, because the
 * ceiling applies to the whole tick and nothing is left that this chain may do.
 */
export function tallyContact(
	tally: SweepTally,
	outcome: ContactOutcome
): { tally: SweepTally; restoreStamp: boolean; stop: boolean } {
	const scanned = { ...tally, scanned: tally.scanned + 1 };
	if (outcome.kind === 'deleted') return { tally: scanned, restoreStamp: false, stop: false };
	if (outcome.deferred) {
		return {
			tally: {
				...scanned,
				deferredSuppressions: scanned.deferredSuppressions + 1,
				isSuppressionCeilingHit: true,
			},
			restoreStamp: true,
			stop: true,
		};
	}
	if (!outcome.applied) return { tally: scanned, restoreStamp: false, stop: false };
	const action = outcome.verdict.action;
	return {
		tally: {
			...scanned,
			reengaged: scanned.reengaged + (action === 'enter_reengagement' ? 1 : 0),
			suppressed: scanned.suppressed + (action === 'suppress' ? 1 : 0),
			resumed: scanned.resumed + (action === 'resume' ? 1 : 0),
		},
		restoreStamp: false,
		stop: false,
	};
}

/** Everything a finished batch does after its last contact. */
export interface SweepEnd {
	readonly result: SweepResult;
	/** The next batch's arguments, when the chain continues. */
	readonly next?: Required<SweepArgs>;
	/** The tick summary for the audit log, when the tick did or refused something irreversible. */
	readonly summary?: AuditDetails;
	/** Operator log lines, in order. */
	readonly warnings: readonly string[];
}

export function decideSweepEnd(input: {
	readonly bounds: SweepBounds;
	readonly tally: SweepTally;
	readonly candidateCount: number;
	readonly corroboratingInstant: number | undefined;
	readonly now: number;
}): SweepEnd {
	const { bounds, tally, candidateCount, now } = input;
	const { suppressed, deferredSuppressions, isSuppressionCeilingHit } = tally;
	const isDone = !isSuppressionCeilingHit && candidateCount < bounds.batchSize;
	const isBudgetExhausted = !isDone && !isSuppressionCeilingHit && bounds.batchesRemaining <= 1;
	const isChaining = !isDone && !isSuppressionCeilingHit && bounds.batchesRemaining > 1;

	const warnings: string[] = [];
	if (isBudgetExhausted) {
		// The chain's return value is dropped, so a log line is the only way an
		// operator learns the book is bigger than one tick's capacity.
		warnings.push(
			`[sunsetSweep] tick exhausted its ${SUNSET_MAX_BATCHES}-batch budget ` +
				`(~${SUNSET_CONTACTS_PER_TICK} contacts) with stale contacts still queued; ` +
				`contacts re-evaluate on a longer cycle than ${SUNSET_STALE_MS}ms`
		);
	}
	if (isSuppressionCeilingHit) {
		warnings.push(
			`[sunsetSweep] suppression ceiling of ${bounds.maxSuppressions} reached; ` +
				`stopped this tick with ${deferredSuppressions} suppression(s) deferred`
		);
	}

	return {
		result: {
			scanned: tally.scanned,
			reengaged: tally.reengaged,
			suppressed,
			resumed: tally.resumed,
			deferredSuppressions,
			isDone,
			isBudgetExhausted,
			isSuppressionCeilingHit,
			isClockSkewed: false,
		},
		...(isChaining
			? {
					next: {
						batchesRemaining: bounds.batchesRemaining - 1,
						batchSize: bounds.batchSize,
						suppressedSoFar: bounds.suppressedSoFar + suppressed,
						maxSuppressions: bounds.maxSuppressions,
						// ALWAYS DEFINED, so every later batch is a non-head and neither
						// re-derives the reading nor re-stamps the shared row. `now` is the
						// right value when the head had none: this tick just corroborated it
						// and stamped it as the heartbeat, so it is the reading the rest of
						// the chain runs under.
						corroboratingInstant: input.corroboratingInstant ?? now,
					},
				}
			: {}),
		// THE OPERATOR-FACING SUMMARY OF THE TICK. Per-contact rows answer "why was
		// this address suppressed"; this one answers the question nobody can ask a
		// per-contact row — "did the engine just suppress a hundred people, and
		// why". Only a tick that did something irreversible or refused to writes it.
		...(suppressed > 0 || deferredSuppressions > 0
			? { summary: tickSummaryDetails(bounds, tally) }
			: {}),
		warnings,
	};
}

function tickSummaryDetails(bounds: SweepBounds, tally: SweepTally): AuditDetails {
	const { suppressed, deferredSuppressions, isSuppressionCeilingHit } = tally;
	return {
		actor: 'sunset_engine',
		scanned: tally.scanned,
		suppressed,
		reengaged: tally.reengaged,
		resumed: tally.resumed,
		deferredSuppressions,
		suppressionCeiling: bounds.maxSuppressions,
		isSuppressionCeilingHit,
		// WORDED OFF THE COUNTS, NOT OFF THE FLAG. A tick that suppressed nothing
		// and merely refused one contact must not tell the operator that a hundred
		// suppressions just happened — the ceiling can be hit with zero
		// suppressions in this tick whenever an earlier batch in the same chain
		// spent the budget, or a caller passed a small ceiling.
		message: isSuppressionCeilingHit
			? `${suppressed} contact(s) auto-suppressed after the configured quiet ` +
				`window; ${deferredSuppressions} more were held back because this ` +
				`sweep reached its ceiling of ${bounds.maxSuppressions} suppressions ` +
				`(${bounds.suppressedSoFar + suppressed} used so far this sweep). The held-back ` +
				`contacts are retried on the next hourly sweep. Review the suppressed ` +
				`contacts and the sunset policy first; any contact can be restored ` +
				`from the suppression list in one action.`
			: `${suppressed} contact(s) auto-suppressed after the configured quiet ` +
				`window. Review or restore them from the suppression list.`,
	};
}
