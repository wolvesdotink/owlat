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
import { loadRouteStateCell, loadStreamlessRouteState } from '../lib/deliverabilityRouteState';
import { getSingletonOrganizationId } from '../lib/sessionOrganization';
import { isSendingAllowed } from '../workspaces/abuseGate';
import { readCellArmBuckets, summarizeTransportOutcomes } from '../analytics/transportOutcomes';
import {
	deferralTelemetryReadSince,
	hasUsableDeferralTelemetry,
	summarizeTransportOutcomeBuckets,
} from '../analytics/transportOutcomeSummary';
import { seedSweepsForCell, type SeedPlacementSweepIndex } from '../analytics/seedPlacementSweeps';
import { RAMP_AIMD } from './ramp/controllerConfig';
import { referenceArmGateEvaluator, trailingBaselineGateEvaluator } from './ramp/gateEvaluation';
import {
	degradedCeilingCap,
	degradedStreamConfig,
	resolveRampDegradation,
	usesTrailingBaseline,
	usesUnsubscribeProxy,
	type RampDegradation,
} from './ramp/degradation';
import { withReferenceArm, type RampDeploymentPresence } from './rampIntegrationPresence';
import { rampConfigForStream, type RampPresetsByStream } from './ramp/presetConfig';
import type { RampPreset } from '@owlat/shared/deliverabilityIndependence';
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
 * THE LOWER BOUND OF THE ONE OWN-ARM READ: whichever of the windows derived from
 * it reaches furthest back.
 *
 * The telemetry bound comes from `deferralTelemetryReadSince` rather than being
 * spelled again here — the dashboard and the phase-promotion rule take it from
 * the same helper, so three readers cannot end up asking one predicate of three
 * different row sets. Taken as a minimum rather than asserted equal, so widening
 * either consumer widens the read instead of silently narrowing the window that
 * depends on it.
 */
function ownHistorySince(now: number): number {
	return Math.min(now - ENGAGEMENT_BASELINE_MS, deferralTelemetryReadSince(now));
}

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
 * IS AN OPERATOR ALLOWED TO RAISE THIS CELL RIGHT NOW?
 *
 * The controls (P3-6) can write a share directly, which means they can reach
 * past the decision function that normally enforces the plan's hard stops. That
 * would make every hard stop optional in exactly the situation it exists for:
 * while the ramp is globally paused for an incident, while the organization is
 * abuse-suspended, while a critical blocklist freeze is running or while the
 * cell is inside a cooldown, an operator could raise the share and the router
 * would read the raised value until the next hourly tick pulled it back.
 *
 * So the mutations ask HERE, through the SAME readers the controller uses —
 * `readHardStopSignals`, the same staleness filter, the same abuse predicate,
 * the same stored freeze — rather than through a second copy of the rules that
 * could drift away from them.
 *
 * ONE-DIRECTIONAL, exactly like the operator's pause and pin. This bounds
 * INCREASES only; a retreat is always permitted, because a safety response an
 * operator cannot reach downward is not a safety response either.
 */
export type RampIncreaseBlock = 'controller_paused' | 'hard_stop_active';

export async function readRampIncreaseBlock(
	ctx: MutationCtx,
	args: {
		organizationId: string;
		cell: DeliverabilityCell;
		perStream: Doc<'deliverabilityRouteStates'>;
		now: number;
	}
): Promise<RampIncreaseBlock | null> {
	const settings = await ctx.db.query('instanceSettings').first();
	// The global kill switch first, and it refuses on its own terms: "everything
	// held still" has to mean everything, including a hand on the control.
	if (settings?.isRampControllerPaused === true) return 'controller_paused';
	const pool = await loadStreamlessRouteState(ctx, args.organizationId, 'all');
	const streamless = await loadStreamlessRouteState(
		ctx,
		args.organizationId,
		args.cell.destinationProvider
	);
	const signals = readHardStopSignals([args.perStream, streamless, pool], {
		isSendingPermitted: isSendingAllowed(settings?.abuseStatus),
		now: args.now,
	});
	if (!signals.isSendingAllowed) return 'hard_stop_active';
	if (signals.isCircuitBreakerOpen) return 'hard_stop_active';
	if (signals.isPoolBlocklisted) return 'hard_stop_active';
	// A cooldown the controller stamped is evidence-bearing state, not a
	// preference: raising through it would discard the retreat that set it.
	if (args.perStream.frozenUntil !== undefined && args.now < args.perStream.frozenUntil) {
		return 'hard_stop_active';
	}
	return null;
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
		/**
		 * THE TICK'S ONE READ OF THE SEED PROBE LEDGER, LAZY and memoized by the
		 * caller for the same two reasons the capacity context is: the read is
		 * org-wide (one bounded index scan covering every cell in the slice), and a
		 * slice with no ramp-managed cell in it must not pay for evidence no gate
		 * will consume.
		 *
		 * Gate 5 is the one gate whose evidence is not written by our own send
		 * pipeline — it comes back from consumer mailboxes through the IMAP poller —
		 * so a cell with nothing in this index is the NORMAL case, not a fault.
		 */
		seeds: () => Promise<SeedPlacementSweepIndex>;
		/**
		 * The deployment's integration presence, read ONCE per tick by the caller
		 * (`rampIntegrationPresence.ts`): every entry but the reference arm is
		 * deployment-level, and the reference arm is completed here from this
		 * cell's own outcome rows.
		 */
		presence: RampDeploymentPresence;
		isKillSwitchEngaged: boolean;
		isSendingPermitted: boolean;
		/**
		 * THE PER-STREAM PRESETS (P3-6), read ONCE for the whole tick: at most three
		 * rows, shared by every cell in the slice. `balanced` is the identity, so a
		 * deployment with no preset rows runs the shipped constants unchanged.
		 */
		presets: RampPresetsByStream;
		/** The deployment default when a stream has no preset row (plan D14). */
		presetFallback: RampPreset;
		now: number;
	}
): Promise<{
	input: RampControllerInput;
	perStream: Doc<'deliverabilityRouteStates'>;
	/**
	 * THE CELL'S SUBSTITUTION RESOLUTION, returned rather than re-derived by the
	 * caller. The cron needs exactly one field off it — `actuator`, which dial
	 * this cell drives (plan D3) — and resolving it a second time up there would
	 * be a second read of the table, free to disagree with the constants this
	 * input was actually built from.
	 */
	degradation: RampDegradation;
} | null> {
	const { organizationId, cell, pool, now } = args;
	const cellKey = deliverabilityCellKey(cell);
	const config = rampConfigForStream(cell.stream, args.presets, args.presetFallback);
	const { perStream, streamless } = await loadRouteStateCell(ctx, organizationId, cell);
	if (!isManagedRouteState(perStream)) return null;
	const mix = readMixState(perStream);

	// THREE OWN-ARM WINDOWS AND ONE INSTRUMENT CHECK, ONE INDEX READ. The gate
	// window (24h), the engagement recent window (7d), the prior baseline (30d..7d)
	// and the deferral telemetry span (30d) are all derived from the same 30 days of
	// own-arm shard rows, so summarizing each separately would fetch the same rows
	// four times — the anti-pattern `readCellArmBuckets` is exported to avoid. The
	// rows come back once and the ONE summarizer runs over each window, so every
	// derived number is identical to the per-window read it replaces. The reference
	// arm has a single window, so it stays a plain summary.
	const ownBuckets = await readCellArmBuckets(ctx.db, {
		organizationId,
		cell: cellKey,
		arm: 'own',
		since: ownHistorySince(now),
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

	// GATE 5'S EVIDENCE, off the tick's one ledger read. Resolved AFTER the
	// managed check above, so an unmanaged slice never triggers it. Both arms are
	// handed over as they stand: the standalone evaluator drops the reference
	// sweep at its own boundary (see `evaluateStandaloneSeedPlacementGate`), which
	// is where that substitution belongs rather than in a conditional here.
	const seedSweeps = seedSweepsForCell(await args.seeds(), cell);

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

	// THE SUBSTITUTION TABLE CHOOSES EVERYTHING BELOW (plan D3, piece P3-8). Which
	// evaluator runs, how many clean windows an increase costs, how big a step is,
	// which complaint line applies and how high the phase ladder may go are all
	// folded out of `RAMP_DEGRADATION_MATRIX`. There is no `if (no relay)` here or
	// anywhere else in the controller: a conditional naming an integration would be
	// a substitution living outside the table, which is the exact failure mode the
	// table exists to prevent.
	//
	// THE OPERATOR'S PRESET AND THE TABLE COMPOSE IN THIS ORDER (plan D9 then D3):
	// `config` above is the per-stream constant table tuned by the operator's
	// aggressiveness preset; the table's tightening is applied ON TOP of it here,
	// LAST, so a missing integration always slows a cell down and an "aggressive"
	// preset can never out-argue a safety substitution.
	const presence = withReferenceArm(args.presence, referenceArm !== null);
	const degradation = resolveRampDegradation({ presence, provider: cell.destinationProvider });
	const degradedConfig = degradedStreamConfig(config, degradation);
	const evaluator = usesTrailingBaseline(degradation)
		? trailingBaselineGateEvaluator
		: referenceArmGateEvaluator;
	const evaluation = evaluator.evaluate({
		config: degradedConfig,
		own,
		reference: referenceArm,
		// The trailing twin's second series, DISJOINT from the evaluation window by
		// construction (30d..7d) — which is what the standalone gates require. The
		// reference-arm evaluator has a concurrent arm and ignores it.
		ownTrailingBaseline: ownPriorBaseline,
		// THROUGH THE FOLD, never off the presence map. `usesUnsubscribeProxy` is
		// the table's answer to "is there a real feedback loop on this cell?", so
		// an integration's presence is read exactly ONCE — by
		// `resolveRampDegradation` — and every consumer asks the RESOLUTION. A
		// direct `presence.<id>` read here would be a substitution living outside
		// the table, which is the one thing this piece exists to prevent (D3).
		hasComplaintFeedback: !usesUnsubscribeProxy(degradation),
		// OBSERVED, NEVER CONFIGURED, exactly as integration presence is
		// (`rampIntegrationPresence.ts` says why), and asked THROUGH THE ONE
		// PREDICATE the dashboard and the phase-promotion rule also ask, over the
		// same span of the same (cell, own) rows. A second spelling of "is this
		// instrumented" is a second chance for the screen, the controller and the
		// promotion rule to disagree about one cell.
		//
		// Over the telemetry span rather than the evaluation window: a quiet day is
		// not the same fact as a cell nothing records deferrals for — and only the
		// second one may hold gate 2, and then only until the span itself answers.
		// The rows read here reach FURTHER back than that span (the engagement
		// baseline needs them); the predicate clamps to its own span, so the extra
		// day cannot make this reader answer differently from the screen.
		hasDeferralTelemetry: hasUsableDeferralTelemetry(ownBuckets, now),
		ownSeeds: seedSweeps.own,
		referenceSeeds: seedSweeps.reference,
		engagement,
		previousCleanStreak: perStream.cleanStreak ?? 0,
		now,
	});

	return {
		perStream,
		degradation,
		input: {
			cell,
			// THE DEGRADED CONFIG, not the preset-tuned one. The controller decides
			// off `input.config` — `cleanWindowsRequired` gates the increase and
			// `increaseStep` sizes it — so handing it the pre-table config would
			// leave the substitution reaching the GATE EVALUATION and nothing else,
			// and the audit snapshot would report constants the tick never used.
			// This is one config for the whole tick, by construction (plan D3, D12).
			config: degradedConfig,
			mix,
			// THE CEILING CAP IS THE TABLE'S TOO (the Microsoft cell caps one rung
			// lower while SNDS is absent). Passed as a BOUND rather than folded into
			// the stored rung, so the promotion an operator was granted survives the
			// outage and the cap lifts by itself when the feed returns.
			phaseCeilingCap: degradedCeilingCap(degradation),
			// The cap's CAUSE travels with the cap, so the audit row and the operator
			// sentence can name the integration whose return would lift it (plan D12).
			ceilingCapSource: degradation.ceilingCappedBy,
			// FOR THE AUDIT ROW ONLY (D12) — the snapshot names the absences behind
			// the constants this tick used, so a decision can be explained without
			// re-deriving what the deployment looked like at the time.
			absentIntegrations: degradation.absent.map((entry) => entry.integration),
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
