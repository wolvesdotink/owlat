/**
 * THE RAMP CONTROLLER'S CRON SHELL.
 *
 * Convex owns the decision — it has the reputation and the outcome data, and it
 * reads MTA state through the EXISTING `/ip-reputation` sync rather than
 * running a second controller on the MTA side. One owner of the decision, no
 * split brain.
 *
 * This module is deliberately THIN: load inputs, call the pure tick core
 * (`ramp/tickDecision.ts`: the slice, both dials, and which writes a cell gets),
 * then apply its plan. Every rule lives under `ramp/`; a conditional here that
 * changes an outcome is a defect, because it would be a rule with no fixture.
 * The READ half — resolving the tenant, reading the route rows and building one
 * cell's `RampControllerInput` — lives in the sibling `rampControllerInputs.ts`,
 * so this file is only the load-call-write shell.
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
 * ABSENCE IS A SUPPORTED CONFIGURATION. No organization, no warming
 * state, no reference transport, no seed mailboxes: every one of those makes
 * the controller measure less and move slower. None of them makes it throw,
 * and none of them blocks a send.
 */

import { v } from 'convex/values';
import { allDeliverabilityCells, deliverabilityCellKey } from '@owlat/shared/deliverabilityRouting';
import { internal } from '../_generated/api';
import { internalMutation } from '../lib/writeFence';
import { isSendingAllowed } from '../workspaces/abuseGate';
import { loadStreamlessRouteState } from '../lib/deliverabilityRouteState';
import { recordAuditLog } from '../lib/auditLog';
import { recordMixDecision } from './rampMixDecisions';
import { loadCellInput, resolveRampOrganizationId } from './rampControllerInputs';
import { summarizeSeedPlacementSweeps } from '../analytics/seedPlacement';
import { loadPaceUtilisation, readPaceState } from './rampPaceInputs';
import { loadRampDeploymentPresence } from './rampIntegrationPresence';
import { loadRampCapacityContext } from './rampCapacityInputs';
import { applyDecision, refreshRouteStateLease } from './rampControllerWrites';
import { decideRampCell, planRampSlice } from './ramp/tickDecision';
import { loadRampPresets } from './rampPresets';

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
 *
 * THE CUT LANDS ON A CODE POINT, not on a UTF-16 code unit. `slice` counts units,
 * so a message whose last unit inside the bound is the first half of an emoji or
 * a CJK extension character would store a LONE SURROGATE — a string no UTF-8
 * encoder can represent, and one a backend is free to reject. This is the path
 * whose job is to survive a bad row, and the audit write below is the last thing
 * standing between a bad row and a silently dead controller, so it must not be
 * the thing that throws.
 */
function readFailureMessage(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	if (text.length <= RAMP_FAILURE_MESSAGE_MAX) return text;
	const cut = text.slice(0, RAMP_FAILURE_MESSAGE_MAX);
	// A trailing HIGH surrogate is half a pair whose other half fell outside the
	// bound; a trailing LOW surrogate is a whole pair that fitted, and stays.
	const last = cut.charCodeAt(cut.length - 1);
	return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * A per-tick read taken at most once, and only when a cell first asks for it.
 * The value is kept, not the promise: a read that throws fails only the cell
 * that asked, and the next cell reads again.
 */
function lazyRead<T>(load: () => Promise<T>): () => Promise<T> {
	let read: { readonly value: T } | undefined;
	return async () => {
		read ??= { value: await load() };
		return read.value;
	};
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
		const slicePlan = planRampSlice(args.cursor, cells.length);
		if (slicePlan === null) return { evaluated: 0, done: true as const };

		// No organization yet means nothing to ramp — a supported configuration,
		// not an error. See `resolveRampOrganizationId`.
		const organizationId = await resolveRampOrganizationId(ctx);
		if (organizationId === null) return { evaluated: 0, done: true as const };

		const settings = await ctx.db.query('instanceSettings').first();
		const isKillSwitchEngaged = settings?.isRampControllerPaused === true;
		const isSendingPermitted = isSendingAllowed(settings?.abuseStatus);

		// Cell-independent, so it is read ONCE for the whole slice rather than once
		// per cell: the pool row carries the same verdict for all fifteen cells.
		const pool = await loadStreamlessRouteState(ctx, organizationId, 'all');

		// AT MOST THREE ROWS, READ ONCE for the whole slice: the per-stream
		// aggressiveness presets. `balanced` is the identity, so a deployment
		// that has never chosen one runs the shipped constants unchanged.
		const { presets, fallback: presetFallback } = await loadRampPresets(ctx, organizationId);

		// Cell-independent for the same reason, and by DERIVATION rather than by
		// approximation: the warming cap is one pool-wide number, so the bound that
		// keeps every governed cell's own-arm volume inside it divides that cap by
		// the projected demand of the cells that pool carries (see
		// `rampCapacityInputs.ts`). Read once per tick; each cell then attaches its
		// own trailing evidence for the audit row.
		//
		// AND READ LAZILY. During rollout most slices contain no
		// ramp-managed cell at all, and the reading is a bounded index read per
		// governed cell. Deferring it until the first managed cell asks means a
		// deployment that has warming state but has not opted any cell into the ramp
		// — the normal state for a long while — pays nothing for a context no cell
		// would have consumed. Memoized, so the cells in a slice still share one.
		const capacity = lazyRead(() => loadRampCapacityContext(ctx, { organizationId, now }));

		// THE PACE ACTUATOR'S EVIDENCE, read ONCE per tick and LAZILY, for the same
		// two reasons the capacity context is: the warming sync reports one
		// pool-wide utilisation reading that every cell in the slice shares, and a
		// slice with no ramp-managed cell in it must not pay for a reading no cell
		// would consume.
		const utilisation = lazyRead(() => loadPaceUtilisation(ctx, { now }));

		// GATE 5'S EVIDENCE, read ONCE per tick and LAZILY, for the same two reasons:
		// the probe ledger read is org-wide and covers every cell in the slice, and
		// a slice with no ramp-managed cell must not pay for it. A deployment with
		// no seed mailboxes reads an empty index, which HOLDS gate 5 — the
		// supported default, not a fault.
		const seeds = lazyRead(() => summarizeSeedPlacementSweeps(ctx.db, organizationId, now));

		// WHICH INTEGRATIONS THIS DEPLOYMENT HAS, read ONCE per tick: every entry but
		// the reference arm is deployment-level, so reading it per cell would repeat
		// the same four index lookups fifteen times. The substitution table
		// is what turns it into each cell's constants — see `rampControllerInputs.ts`.
		const presence = await loadRampDeploymentPresence(ctx, { organizationId, now });

		const slice = cells.slice(slicePlan.start, slicePlan.end);
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
				const plan = decideRampCell({
					input,
					degradation,
					pace: readPaceState(perStream),
					control: {
						pausedAt: perStream.operatorPausedAt,
						pinnedShare: perStream.operatorPinnedShare,
					},
					utilisation: await utilisation(),
					isKillSwitchEngaged,
					now,
				});
				evaluated += 1;

				// THE AUDIT ROW COMES FIRST AND ALWAYS — including for the
				// no-ops, and including while the kill switch is pinning every cell. It
				// carries BOTH actuators, so "what did the controller do to this cell at
				// 14:00" is one row rather than a join.
				await recordMixDecision(ctx, {
					organizationId,
					cell,
					input,
					decision: plan.decision,
					pace: plan.recordedPace,
					at: now,
				});
				if (plan.write.kind === 'lease') {
					await refreshRouteStateLease(ctx, perStream, now);
					continue;
				}
				await applyDecision(ctx, {
					perStream,
					decision: plan.decision,
					pace: plan.pace,
					isPaceDeferred: plan.isPaceDeferred,
					now,
				});
				if (plan.write.audit === null) continue;
				await recordAuditLog(ctx, {
					userId: 'system',
					organizationId,
					action: 'deliverability_ramp.decision_applied',
					resource: 'deliverability_ramp',
					resourceId: deliverabilityCellKey(cell),
					details: plan.write.audit,
				});
			} catch (error) {
				// ONE CELL MUST NOT TAKE THE SLICE DOWN WITH IT.
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
				//
				// AND THIS WRITE CANNOT BE ALLOWED TO THROW. There is no catch behind this
				// catch: an audit write that failed here would abort the slice and the
				// continuation with it — the exact starvation the isolation exists to
				// prevent, reached through the handler for it. So the row carries nothing
				// but values this module chose: the cell key, and a message bounded and cut
				// on a code-point boundary by `readFailureMessage`.
				console.error(`[RampController] ${deliverabilityCellKey(cell)} failed:`, error);
				await recordAuditLog(ctx, {
					userId: 'system',
					organizationId,
					action: 'deliverability_ramp.cell_evaluation_failed',
					resource: 'deliverability_ramp',
					resourceId: deliverabilityCellKey(cell),
					details: { cell: deliverabilityCellKey(cell), error: readFailureMessage(error) },
				});
			}
		}

		if (slicePlan.continueAt !== null) {
			await ctx.scheduler.runAfter(0, internal.delivery.rampControllerCron.runRampController, {
				cursor: slicePlan.continueAt,
			});
		}
		return { evaluated, done: slicePlan.continueAt === null };
	},
});
