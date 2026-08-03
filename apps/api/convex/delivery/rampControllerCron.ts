/**
 * THE RAMP CONTROLLER'S CRON SHELL (plan D13, D15).
 *
 * Convex owns the decision — it has the reputation and the outcome data, and it
 * reads MTA state through the EXISTING `/ip-reputation` sync rather than
 * running a second controller on the MTA side. One owner of the decision, no
 * split brain.
 *
 * This module is deliberately THIN: load inputs, call the pure `nextShare`,
 * write the result and the audit row. Every rule lives in `controller.ts`; a
 * conditional here that changes an outcome is a defect, because it would be a
 * rule with no fixture. The READ half — resolving the tenant, reading the route
 * rows and building one cell's `RampControllerInput` — lives in the sibling
 * `rampControllerInputs.ts`, so this file is only the decide-and-write half.
 *
 * BOUNDED PER TICK. The cell grid is stream x destinationProvider (15 cells).
 * Each tick takes a slice, writes it, and self-schedules for the next slice, so
 * one mutation's read and write set stays small however the grid grows.
 *
 * AND ISOLATED PER CELL. Each cell is evaluated inside its own try/catch, because
 * a throw would otherwise roll back the slice — the self-scheduled continuation
 * with it — and one bad row would starve every cell behind it in the grid until a
 * human noticed. A failed cell records an audit row and the loop carries on.
 *
 * WHY THIS LIVES IN `delivery/` AND NOT IN `delivery/ramp/`: everything under
 * `ramp/` is the PURE decision core, and `ramp/__tests__/gates.purity.test.ts`
 * enumerates that directory and forbids a clock, a database handle or a Convex
 * function wrapper in any file it finds. The shell needs all three. Keeping it
 * outside means the guard stays at full strength and "is delivery/ramp/ pure?"
 * stays a question with a yes/no answer.
 *
 * ABSENCE IS A SUPPORTED CONFIGURATION (plan D2). No organization, no warming
 * state, no reference transport, no seed mailboxes: every one of those makes
 * the controller measure less and move slower. None of them makes it throw,
 * and none of them blocks a send.
 */

import { v } from 'convex/values';
import { allDeliverabilityCells, deliverabilityCellKey } from '@owlat/shared/deliverabilityRouting';
import { internal } from '../_generated/api';
import { internalMutation } from '../_generated/server';
import { isSendingAllowed } from '../workspaces/abuseGate';
import { loadStreamlessRouteState } from '../lib/deliverabilityRouteState';
import { recordAuditLog } from '../lib/auditLog';
import { nextShare } from './ramp/controller';
import { nextPaceMultiplier } from './ramp/paceActuator';
import { composeActuators } from './ramp/actuatorComposition';
import { recordMixDecision } from './rampMixDecisions';
import { loadCellInput, resolveRampOrganizationId } from './rampControllerInputs';
import { summarizeSeedPlacementSweeps } from '../analytics/seedPlacement';
import type { SeedPlacementSweepIndex } from '../analytics/seedPlacementSweeps';
import { loadPaceUtilisation, readPaceState } from './rampPaceInputs';
import { loadRampDeploymentPresence } from './rampIntegrationPresence';
import { loadRampCapacityContext, type RampCapacityContext } from './rampCapacityInputs';
import { rampDecisionChangedState } from './ramp/controllerTypes';
import { applyDecision, refreshRouteStateLease } from './rampControllerWrites';
import { paceDecisionChangedState, type PaceUtilisationReading } from './ramp/paceTypes';
import { applyPaceCellControl, applyRampCellControl } from './ramp/controlOverride';
import { loadRampPresets } from './rampPresets';

/** Cells evaluated per tick. The grid is 15; three ticks cover it. */
const RAMP_CELLS_PER_TICK = 5;

/**
 * How much of a thrown message one failed cell may put in the audit row.
 *
 * EXPORTED FOR THE FIXTURE THAT PINS IT: a bound with no test is a rule that can
 * be deleted without anything going red, and this one changes what reaches the
 * audit table.
 */
export const RAMP_FAILURE_MESSAGE_MAX = 200;

/**
 * What a failed cell puts on the record. Not a rule and not a decision: the
 * message of an `Error`, or the value itself when something else was thrown,
 * bounded so a cell that fails on every tick cannot grow the audit table by
 * whatever a stack trace happened to carry.
 */
function readFailureMessage(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	return text.slice(0, RAMP_FAILURE_MESSAGE_MAX);
}

/**
 * The hourly tick. `cursor` is an index into the stable cell grid, so a tick
 * always resumes where the previous one stopped and never re-reads the whole
 * grid in one transaction.
 */
export const runRampController = internalMutation({
	args: { cursor: v.optional(v.number()) },
	handler: async (ctx, args) => {
		const now = Date.now();
		const cells = allDeliverabilityCells();
		const rawCursor = args.cursor ?? 0;
		const cursor = Number.isFinite(rawCursor) ? Math.max(0, Math.floor(rawCursor)) : 0;
		if (cursor >= cells.length) return { evaluated: 0, done: true as const };

		// No organization yet means nothing to ramp — a supported configuration,
		// not an error (plan D2). See `resolveRampOrganizationId`.
		const organizationId = await resolveRampOrganizationId(ctx);
		if (organizationId === null) return { evaluated: 0, done: true as const };

		const settings = await ctx.db.query('instanceSettings').first();
		const isKillSwitchEngaged = settings?.isRampControllerPaused === true;
		const isSendingPermitted = isSendingAllowed(settings?.abuseStatus);

		// Cell-independent, so it is read ONCE for the whole slice rather than once
		// per cell: the pool row carries the same verdict for all fifteen cells.
		const pool = await loadStreamlessRouteState(ctx, organizationId, 'all');

		// AT MOST THREE ROWS, READ ONCE for the whole slice: the per-stream
		// aggressiveness presets (P3-6). `balanced` is the identity, so a deployment
		// that has never chosen one runs the shipped constants unchanged.
		const { presets, fallback: presetFallback } = await loadRampPresets(ctx, organizationId);

		// Cell-independent for the same reason, and by DERIVATION rather than by
		// approximation: the warming cap is one pool-wide number, so the bound that
		// keeps every governed cell's own-arm volume inside it divides that cap by
		// the projected demand of the cells that pool carries (see
		// `rampCapacityInputs.ts`). Read once per tick; each cell then attaches its
		// own trailing evidence for the audit row.
		//
		// AND READ LAZILY. During rollout (plan D1) most slices contain no
		// ramp-managed cell at all, and the reading is a bounded index read per
		// governed cell. Deferring it until the first managed cell asks means a
		// deployment that has warming state but has not opted any cell into the ramp
		// — the normal state for a long while — pays nothing for a context no cell
		// would have consumed. Memoized, so the cells in a slice still share one.
		let capacityContext: RampCapacityContext | null = null;
		const capacity = async (): Promise<RampCapacityContext> => {
			capacityContext ??= await loadRampCapacityContext(ctx, { organizationId, now });
			return capacityContext;
		};

		// THE PACE ACTUATOR'S EVIDENCE, read ONCE per tick and LAZILY, for the same
		// two reasons the capacity context is: the warming sync reports one
		// pool-wide utilisation reading that every cell in the slice shares, and a
		// slice with no ramp-managed cell in it must not pay for a reading no cell
		// would consume.
		let utilisationReading: PaceUtilisationReading | null = null;
		const utilisation = async (): Promise<PaceUtilisationReading> => {
			utilisationReading ??= await loadPaceUtilisation(ctx, { now });
			return utilisationReading;
		};

		// GATE 5'S EVIDENCE, read ONCE per tick and LAZILY, for the same two reasons:
		// the probe ledger read is org-wide and covers every cell in the slice, and
		// a slice with no ramp-managed cell must not pay for it. A deployment with
		// no seed mailboxes reads an empty index, which HOLDS gate 5 — the
		// supported default, not a fault (plan D2).
		let seedSweepIndex: SeedPlacementSweepIndex | null = null;
		const seeds = async (): Promise<SeedPlacementSweepIndex> => {
			seedSweepIndex ??= await summarizeSeedPlacementSweeps(ctx.db, organizationId, now);
			return seedSweepIndex;
		};

		// WHICH INTEGRATIONS THIS DEPLOYMENT HAS, read ONCE per tick: every entry but
		// the reference arm is deployment-level, so reading it per cell would repeat
		// the same four index lookups fifteen times. The substitution table (plan D3)
		// is what turns it into each cell's constants — see `rampControllerInputs.ts`.
		const presence = await loadRampDeploymentPresence(ctx, { organizationId, now });

		const slice = cells.slice(cursor, cursor + RAMP_CELLS_PER_TICK);
		let evaluated = 0;
		for (const cell of slice) {
			try {
				const loaded = await loadCellInput(ctx, {
					organizationId,
					cell,
					pool,
					capacity,
					seeds,
					presence,
					isKillSwitchEngaged,
					isSendingPermitted,
					presets,
					presetFallback,
					now,
				});
				// An unmanaged cell is not an evaluation: there is no share to decide
				// about, and inventing one would change shipped routing.
				if (loaded === null) continue;
				const { input, perStream, degradation } = loaded;
				// WHICH DIAL THIS CELL DRIVES (plan D3), off the substitution table and
				// not off a `hasRelay` boolean here: `resolveRampDegradation` returns
				// 'pace' exactly when the reference transport is absent, which is the
				// same mechanism that chose this cell's evaluator, its K_CLEAN and its
				// ceiling cap. Standalone is therefore the DEGENERATE CASE the
				// composition function already documents (`share: null`) rather than a
				// branch scattered through the controller.
				const isPaceActuated = degradation.actuator === 'pace';
				// THE OPERATOR'S HAND, applied AFTER the pure ladder and BEFORE anything is
				// recorded (P3-6): a pause suppresses an increase and a pin caps one, and
				// neither can hold a retreat. Rewriting the decision here — rather than
				// threading a control flag through the ladder — is what keeps the audit row
				// honest: it records what the operator's setting actually produced, and the
				// controller's own rungs stay untouched.
				//
				// ONE READING OF THE CONTROLS FOR BOTH DIALS. A pause reaches the pace
				// ladder too (`applyPaceCellControl` below), because "hold this cell"
				// cannot mean "hold the share" on a deployment whose only dial is the
				// warm-up pace — the configuration the standalone twin exists for. The PIN
				// is share-only by construction and not by omission: it is expressed in
				// share, and the pace dial is a multiplier on a daily cap.
				const control = {
					pausedAt: perStream.operatorPausedAt,
					pinnedShare: perStream.operatorPinnedShare,
				};
				const decision = applyRampCellControl(nextShare(input), control);
				// THE SECOND ACTUATOR, on the SAME gates, the SAME hard stops and the
				// SAME kill switch (plan D3). Standalone it is the only dial that moves —
				// s === 1 by definition — and with a reference arm it is the slow,
				// reputation-bearing half of a composed decision.
				const paceReading = await utilisation();
				// THE SAME HAND ON THIS DIAL, under the same one-directional rule and the
				// same override module: a pause suppresses the pace INCREASE and can never
				// hold the retreat. Applied here rather than after the composition so the
				// interlock below sees the decision the operator actually produced — a
				// suppressed increase is not an increase to defer, and stamping the
				// deferral anchor for one would hold this dial a further window after the
				// pause is lifted.
				const paceDecision = applyPaceCellControl(
					nextPaceMultiplier({
						config: input.config,
						pace: readPaceState(perStream),
						signals: input.signals,
						evaluation: input.evaluation,
						utilisation: paceReading,
						// The table's step factor, RAW — see `PaceControllerInput.stepMultiplier`
						// for why it cannot travel folded into `config` the way K_CLEAN does.
						stepMultiplier: degradation.stepMultiplier,
						isKillSwitchEngaged,
						now,
					}),
					control
				);
				// THE COMPOSITION ORDER IS FIXED (plan D3): share moves FIRST (cheap and
				// instantly reversible — the relay absorbs the difference), pace moves
				// SECOND (slow and reputation-bearing), and a cell may NEVER increase both
				// in one window. The interlock lives in one pure function so that
				// property is a fixture rather than an inline conditional here — and it
				// is enforced in TWO places on purpose: this call withholds the step on
				// the tick the share moved, and the anchor it stamps
				// (`paceDeferredAt`) keeps the pace ladder holding for the rest of the
				// share's evaluation window. This cron ticks hourly; the window is a day.
				// A PACE-ACTUATED CELL HANDS THE COMPOSITION NO SHARE — the `share: null`
				// degenerate case the composition module documents, now reachable from
				// production. It is not cosmetic: the interlock defers a pace increase for
				// a WHOLE share evaluation window whenever the share stepped, so handing it
				// a live share decision on a deployment that has no reference transport to
				// shift traffic to would hold the only dial this cell owns for the entire
				// ramp — the headline deliverable of the standalone twin, starved.
				//
				// THE SHARE DECISION IS STILL APPLIED. Composition only ever holds the
				// PACE dial back, and the share half of the row is still the deployment's
				// safety interlock: a hard stop zeroes it, a critical blocklist freezes it,
				// and `isFallbackActive` is derived from it. Declining to write it on a
				// pace-actuated cell would silently drop shipped hard-stop behaviour on
				// exactly the configuration this piece exists to serve.
				const composed = composeActuators({
					share: isPaceActuated ? null : decision,
					pace: paceDecision,
				});
				evaluated += 1;

				// THE AUDIT ROW COMES FIRST AND ALWAYS (plan D12) — including for the
				// no-ops, and including while the kill switch is pinning every cell. It
				// carries BOTH actuators, so "what did the controller do to this cell at
				// 14:00" is one row rather than a join.
				await recordMixDecision(ctx, {
					organizationId,
					cell,
					input,
					decision,
					pace: {
						decision: composed.pace,
						utilisation: paceReading,
						isDeferred: composed.isPaceDeferred,
					},
					at: now,
				});

				// A PAUSED CONTROLLER WRITES NO SHARE. It still evaluates, still audits —
				// so an operator can watch what it would have done — and still renews the
				// row's lease, because "pinned" has to survive longer than the cache TTL.
				if (isKillSwitchEngaged) {
					await refreshRouteStateLease(ctx, perStream, now);
					continue;
				}

				await applyDecision(ctx, {
					perStream,
					decision,
					pace: composed.pace,
					isPaceDeferred: composed.isPaceDeferred,
					now,
				});
				// EVERY AUTOMATIC CHANGE IS AUDITED (plan D12) — which is a wider predicate
				// than "the share moved". A gate breach on a cell already sitting on
				// `RAMP_AIMD.shareFloor` returns direction 'hold' (`max(floor, floor x
				// 0.5)` is the floor), yet `applyDecision` has just rewritten the freeze
				// expiry, the cooldown rung, the clean streak, the green clock and the
				// graduation pin. That is a real automatic change and belongs in
				// `auditLogs`. `rampDecisionChangedState` is that predicate, and it is
				// SHARED with the admin notice rather than spelled out twice: the log and
				// the notice must never be able to disagree about whether something
				// happened. An ordinary hold rewrites nothing but the lease and stays out
				// of the log — see `rampDecisionAdminNotice` for why it is exact.
				//
				// THE PIN TRANSITION IS THE PIECE'S TERMINAL STATE CHANGE and it moves no
				// share at all: graduation holds the number (the pinned target IS the
				// current share) and imposes no freeze, while `applyDecision` above has
				// just written `graduatedAt` onto a row that had none — the cell pins and
				// the relay drops to `priority_failover` standby. `decision.pinChange`
				// carries that transition, so the tick a cell graduates — and the tick a
				// hard stop takes the pin away again — are both in the audit log.
				// AND THE SAME PREDICATE APPLIES TO THE SECOND DIAL, in the same shape as
				// `rampDecisionChangedState`: the dial MOVED, or a gate breach advanced
				// the cooldown ladder. A pace retreat on a cell whose share held is a real
				// automatic change and an operator cannot explain one no log records —
				// while a hard stop that is merely STILL TRUE an hour later re-stamps a
				// freeze without changing anything, and must stay as quiet here as it does
				// on the share side.
				//
				// BOTH PREDICATES ARE NAMED FUNCTIONS BESIDE THE DECISIONS THEY READ.
				// This file's own header rule is that a conditional here which changes an
				// outcome is a defect, because it is a rule with no fixture; the pace half
				// used to be spelled inline, one expression away from silently disagreeing
				// with the share half about what "something happened" means.
				if (!rampDecisionChangedState(decision) && !paceDecisionChangedState(composed.pace)) {
					continue;
				}
				await recordAuditLog(ctx, {
					userId: 'system',
					organizationId,
					action: 'deliverability_ramp.decision_applied',
					resource: 'deliverability_ramp',
					resourceId: deliverabilityCellKey(cell),
					details: {
						cell: deliverabilityCellKey(cell),
						fromShare: decision.fromShare,
						toShare: decision.share,
						direction: decision.direction,
						reason: decision.reason,
						verdict: decision.verdict,
						...(decision.failedGate === undefined ? {} : { failedGate: decision.failedGate }),
						...(decision.pinChange === undefined ? {} : { pinChange: decision.pinChange }),
						// The pace dial is part of the same automatic change and is logged
						// with it: an operator reading the audit trail must be able to see
						// which of the two dials moved, and why.
						fromPaceMultiplier: composed.pace.fromMultiplier,
						toPaceMultiplier: composed.pace.multiplier,
						paceDirection: composed.pace.direction,
						paceReason: composed.pace.reason,
					},
				});
			} catch (error) {
				// ONE CELL MUST NOT TAKE THE SLICE DOWN WITH IT (plan D2, D13).
				//
				// A mutation that throws rolls back its WHOLE transaction, the
				// self-scheduled continuation at the bottom of this handler included — so a
				// single cell whose read hit a corrupt row would abort every cell after it
				// in the slice AND every slice after that one, and the controller would
				// simply stop until the next hourly tick re-entered at cursor 0 and met the
				// same cell again. A cell late in the grid could starve for ever behind one
				// early in it — which matters now that enrolment can actually put cells
				// under management.
				//
				// THE FAILURE IS RECORDED, NOT SWALLOWED. There is no nested transaction to
				// roll back to, so whatever this cell had already written stays written, and
				// a half-applied cell is exactly the thing an operator has to be able to
				// find afterwards. It is an `auditLogs` row and deliberately NOT a
				// `mixDecisions` one: no decision was reached, and inventing a row in the
				// evidence timeline would put a share the controller never decided in front
				// of whoever replays the cell later.
				console.error(`[RampController] ${deliverabilityCellKey(cell)} failed:`, error);
				await recordAuditLog(ctx, {
					userId: 'system',
					organizationId,
					action: 'deliverability_ramp.cell_evaluation_failed',
					resource: 'deliverability_ramp',
					resourceId: deliverabilityCellKey(cell),
					details: {
						cell: deliverabilityCellKey(cell),
						// BOUNDED, because the text is a thrown message and not a value this
						// module chose: a cell that fails on every tick must not be able to
						// grow the audit table by whatever a stack trace happens to carry.
						error: readFailureMessage(error),
					},
				});
			}
		}

		const nextCursor = cursor + slice.length;
		if (nextCursor < cells.length) {
			await ctx.scheduler.runAfter(0, internal.delivery.rampControllerCron.runRampController, {
				cursor: nextCursor,
			});
		}
		return { evaluated, done: nextCursor >= cells.length };
	},
});
