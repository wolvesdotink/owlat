/**
 * THE RAMP CONTROLLER'S READ HALF (plan D15).
 *
 * `rampControllerCron.ts` is the shell that DECIDES and WRITES; this module is
 * everything it READS. Splitting on that line keeps both halves under the
 * file-size cap and, more usefully, makes the shell's contract legible: it calls
 * one function per cell, gets a `RampControllerInput` or `null`, and never
 * touches a table on the way in.
 *
 * NOTHING HERE DECIDES ANYTHING. Every rule lives in `delivery/ramp/`; a
 * conditional in this file that changes an outcome is a defect, because it would
 * be a rule with no fixture. The one judgement it does make is a CLASSIFICATION —
 * is this cell managed by the ramp at all — and that is a property of the stored
 * row, not of the decision.
 *
 * WHY NOT IN `delivery/ramp/`: that directory is the PURE core, and
 * `ramp/__tests__/gates.purity.test.ts` enumerates it and forbids a clock, a
 * database handle or a Convex function wrapper in any file it finds. This module
 * needs a database handle. Keeping it outside means the guard stays at full
 * strength and "is delivery/ramp/ pure?" stays a question with a yes/no answer.
 *
 * ABSENCE IS A SUPPORTED CONFIGURATION (plan D2). No organization, no warming
 * state, no reference transport, no seed mailboxes: every one of those makes the
 * controller measure less and move slower. None of them makes it throw.
 */

import {
	deliverabilityCellKey,
	hasCriticalBlocklistSignal,
	type DeliverabilityCell,
} from '@owlat/shared/deliverabilityRouting';
import type { Doc } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { loadRouteStateCell } from '../lib/deliverabilityRouteState';
import { getSingletonOrganizationId } from '../lib/sessionOrganization';
import { readCellArmBuckets, summarizeTransportOutcomes } from '../analytics/transportOutcomes';
import { summarizeTransportOutcomeBuckets } from '../analytics/transportOutcomeSummary';
import { RAMP_AIMD } from './ramp/controllerConfig';
import { RAMP_STREAM_CONFIGS } from './ramp/gateConfig';
import { referenceArmGateEvaluator } from './ramp/gateEvaluation';
import { evaluateEngagementGate } from './ramp/engagementGate';
import { DELIVERABILITY_SIGNAL_MAX_AGE_MS } from './deliverabilityRouting';
import { capacityInputForCell, type RampCapacityContext } from './rampCapacityInputs';
import type {
	RampControllerInput,
	RampHardStopSignals,
	RampMixState,
} from './ramp/controllerTypes';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/**
 * The gate evaluation window: one day of outcomes. Taken from the controller's
 * own constant rather than re-declared, because the SAME number is what spaces
 * two counted windows apart — the cron ticks hourly, so a query window and a
 * streak-spacing window that could disagree would let three overlapping reads of
 * the same day satisfy K_CLEAN.
 */
const RAMP_WINDOW_MS = RAMP_AIMD.evaluationWindowMs;
/** The engagement floor's recent window and the prior baseline it is compared to. */
const ENGAGEMENT_RECENT_MS = 7 * DAY_MS;
const ENGAGEMENT_BASELINE_MS = 30 * DAY_MS;

/**
 * The deployment's tenant, through the SAME resolver every other org-scoped
 * background writer uses (`analytics/transportOutcomes.ts` does exactly this).
 * A cron must never be able to fail on an auth lookup, so a throw is read as
 * "no organization yet" — a supported configuration, not an error (plan D2).
 */
export async function resolveRampOrganizationId(ctx: MutationCtx): Promise<string | null> {
	try {
		return await getSingletonOrganizationId(ctx);
	} catch {
		return null;
	}
}

/**
 * Infrastructure verdicts, read off whichever route-state rows exist.
 *
 * WHICH ROWS MATTER IS NOT THE SAME PER SIGNAL. `breaker_open` is emitted per
 * destination provider, and `applySnapshot` files it onto the STREAMLESS row for
 * that provider — the cell's `streamless` row, not its per-stream one, which is
 * the ramp's own state and carries no MTA signals. Pool-level blocklist
 * and quarantine signals are emitted by the MTA against the WHOLE pool with
 * `provider: 'all'`, and `applySnapshot` files them onto the `'all'` row only —
 * so a controller that read the cell's rows alone would never see one, and the
 * plan's critical-blocklist hard stop would be dead code. Every caller passes
 * the pool row as well.
 *
 * The blocklist test itself is the SHIPPED predicate, not a local copy: one
 * definition of "critically blocklisted" for routing and for the ramp.
 *
 * AND ONE DEFINITION OF "STILL TRUE". The shipped router only acts on a row it
 * has heard from within `DELIVERABILITY_SIGNAL_MAX_AGE_MS` (`routeInputs.ts`),
 * so a snapshot that stopped arriving stops steering traffic. The controller
 * applies the SAME filter: a row the router has already stopped acting on must
 * not still be driving the ramp's breaker and blocklist hard stops. Without it
 * the two layers could disagree about whether a signal counts — and because the
 * breaker rung halves without a floor, a signal that goes stale rather than
 * being cleared would walk the cell toward zero over successive freezes.
 *
 * That filter is only honest because the controller does NOT stamp `updatedAt`
 * (see `applyDecision`): on every row in this scan — the cell's per-stream row
 * included — `updatedAt` means "when a snapshot last wrote this row", exactly
 * what the router means by it. The per-stream row carries no MTA signals today,
 * so in practice `streamless` and `pool` are what answer here; it stays in the
 * list so that a per-stream snapshot writer would be honoured automatically,
 * under the same expiry rule as the router rather than a second one.
 */
function readHardStopSignals(
	rows: readonly (Doc<'deliverabilityRouteStates'> | null)[],
	args: { readonly isSendingPermitted: boolean; readonly now: number }
): RampHardStopSignals {
	let isCircuitBreakerOpen = false;
	let isPoolBlocklisted = false;
	for (const row of rows) {
		if (row === null) continue;
		if (args.now - row.updatedAt > DELIVERABILITY_SIGNAL_MAX_AGE_MS) continue;
		const { signals } = row;
		if (signals.some((signal) => signal.source === 'breaker_open')) isCircuitBreakerOpen = true;
		if (hasCriticalBlocklistSignal(signals)) isPoolBlocklisted = true;
	}
	return { isSendingAllowed: args.isSendingPermitted, isCircuitBreakerOpen, isPoolBlocklisted };
}

/**
 * A cell the ramp MANAGES: a per-stream route-state row that carries a stored
 * share. A row without one is governed entirely by the shipped boolean plus
 * hysteresis, and the controller leaves it alone (plan D1).
 */
type ManagedRouteState = Doc<'deliverabilityRouteStates'> & { readonly ownShare: number };

function isManagedRouteState(
	row: Doc<'deliverabilityRouteStates'> | null
): row is ManagedRouteState {
	return row !== null && row.ownShare !== undefined;
}

/**
 * The STORED state of a MANAGED cell, read out verbatim.
 *
 * `share` is deliberately NOT normalised here. The shared `resolveOwnShare`
 * clamps a stored `ownShare` on the way out, which is right for every routing
 * reader — but handing the controller a clamped value would mean a row holding
 * `-0.5`, `1.5` or `NaN` arrives as a perfectly ordinary `0` or `1`, the
 * decision function's `share_unreadable` rung could never fire in production,
 * and a corrupt row would be stepped UP on the next clean tick (or start a
 * graduation clock).
 *
 * The ABSENT-share case is not handled here either: a row without `ownShare` is
 * an UNMANAGED cell, and the caller returns before reaching this function. One
 * definition of "managed", in the one place that decides it.
 */
function readMixState(row: ManagedRouteState): RampMixState {
	return {
		share: row.ownShare,
		phaseCeiling: row.phaseCeiling,
		cleanStreak: row.cleanStreak,
		frozenUntil: row.frozenUntil,
		freezeReason: row.freezeReason,
		freezeStartedAt: row.freezeStartedAt,
		cooldownMs: row.cooldownMs,
		greenSince: row.greenSince,
		graduatedAt: row.graduatedAt,
		lastCountedAt: row.lastCountedAt,
	};
}

/**
 * Build the controller input for one cell. Reads only; decides nothing.
 *
 * `null` means the cell is UNMANAGED: no per-stream row carries a share, so the
 * cell is still governed entirely by the shipped boolean + hysteresis on the
 * stream-less row. The controller does not seed a share here — seeding is the
 * transport-connection flow's act, and a controller that invented one would
 * change shipped routing on a deployment that never opted into the ramp (D1:
 * no behaviour change until the controller starts writing shares).
 */
export async function loadCellInput(
	ctx: MutationCtx,
	args: {
		organizationId: string;
		cell: DeliverabilityCell;
		/**
		 * The POOL-WIDE slice, read ONCE per tick by the caller: every blocklist /
		 * quarantine signal the MTA reports is filed against `provider: 'all'`, so
		 * it lives on no cell's row — and it is cell-independent, so reading it in
		 * here would be the same index lookup repeated once per cell.
		 */
		pool: Doc<'deliverabilityRouteStates'> | null;
		/**
		 * The tick's ONE capacity reading, LAZY and memoized by the caller: the
		 * bound is deployment-level by derivation (see `rampCapacityInputs.ts`), so
		 * reading it per cell would be the same index reads repeated once per cell
		 * — and a slice with no ramp-managed cell in it (the normal state during
		 * rollout, plan D1) must not pay for a reading no cell will consume, which
		 * is why it is a thunk rather than a value. It is handed to
		 * `capacityInputForCell` UNRESOLVED, so a slice of cells the campaign pool
		 * does not govern — the stream-major cursor produces exactly such slices —
		 * does not resolve it either.
		 */
		capacity: () => Promise<RampCapacityContext>;
		isKillSwitchEngaged: boolean;
		isSendingPermitted: boolean;
		now: number;
	}
): Promise<{ input: RampControllerInput; perStream: Doc<'deliverabilityRouteStates'> } | null> {
	const { organizationId, cell, pool, now } = args;
	const cellKey = deliverabilityCellKey(cell);
	const { perStream, streamless } = await loadRouteStateCell(ctx, organizationId, cell);
	if (!isManagedRouteState(perStream)) return null;
	const mix = readMixState(perStream);

	// THREE OWN-ARM WINDOWS, ONE INDEX READ. The gate window (24h), the engagement
	// recent window (7d) and the prior baseline (30d..7d) are all sub-windows of the
	// same 30 days of own-arm shard rows, so summarizing each separately would fetch
	// the same rows up to three times — the anti-pattern `readCellArmBuckets` is
	// exported to avoid. The rows come back once and the ONE summarizer runs over
	// each window, so every derived number is identical to the per-window read it
	// replaces. The reference arm has a single window, so it stays a plain summary.
	const ownBuckets = await readCellArmBuckets(ctx.db, {
		organizationId,
		cell: cellKey,
		arm: 'own',
		since: now - ENGAGEMENT_BASELINE_MS,
	});
	const own = summarizeTransportOutcomeBuckets(ownBuckets, { since: now - RAMP_WINDOW_MS });
	const ownRecent = summarizeTransportOutcomeBuckets(ownBuckets, {
		since: now - ENGAGEMENT_RECENT_MS,
	});
	const ownPriorBaseline = summarizeTransportOutcomeBuckets(ownBuckets, {
		since: now - ENGAGEMENT_BASELINE_MS,
		until: now - ENGAGEMENT_RECENT_MS,
	});
	const reference = await summarizeTransportOutcomes(ctx.db, {
		organizationId,
		cell: cellKey,
		arm: 'reference',
		since: now - RAMP_WINDOW_MS,
	});

	// The reference arm is ABSENT, not empty, when nothing was sent through it:
	// an empty summary would read as "the relay engaged 0% of its recipients"
	// and fail a ratio the deployment never opted into (plan D2).
	const referenceArm = reference.sent > 0 ? reference : null;
	const engagement = evaluateEngagementGate({
		cell,
		own,
		reference: referenceArm,
		ownRecent,
		ownPriorBaseline,
		now,
	});

	// WHICH EVALUATOR RUNS IS P3-8's CHOICE, not this file's. The base branch now
	// ships `trailingBaselineGateEvaluator` beside this one, and a deployment with
	// no reference arm (`referenceArm === null` above) wants that twin rather than
	// this one — evaluated by the reference implementation it can only ever hold.
	// P3-8's substitution table is what selects between them; the hard-coded
	// evaluator here is STAGED, exactly as the capacity input below was until P3-3
	// replaced its stand-in with a real projection.
	const evaluation = referenceArmGateEvaluator.evaluate({
		config: RAMP_STREAM_CONFIGS[cell.stream],
		own,
		reference: referenceArm,
		engagement,
		previousCleanStreak: perStream.cleanStreak ?? 0,
		now,
	});

	return {
		perStream,
		input: {
			cell,
			config: RAMP_STREAM_CONFIGS[cell.stream],
			mix,
			signals: readHardStopSignals([perStream, streamless, pool], {
				isSendingPermitted: args.isSendingPermitted,
				now,
			}),
			evaluation,
			// THE PREDICTIVE CAPACITY BOUND (P3-3), read ONCE for the tick — lazily,
			// so an unmanaged slice never pays for it — and specialised here with this
			// cell's own trailing evidence for the audit row. The shortfall is
			// measured against the STORED share, which makes it a LAGGING indicator
			// (see `deliveredShareShortfall`): a `warmup_overflow` reroute shows up in
			// it, and so does a share the controller itself raised yesterday.
			capacity: await capacityInputForCell(args.capacity, cell, mix.share),
			isKillSwitchEngaged: args.isKillSwitchEngaged,
			now,
		},
	};
}
