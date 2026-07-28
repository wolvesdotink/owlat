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
import {
	allDeliverabilityCells,
	deliverabilityCellKey,
	isFallbackActiveForShare,
	type DeliverabilityCell,
} from '@owlat/shared/deliverabilityRouting';
import type { Doc } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import { internalMutation, type MutationCtx } from '../_generated/server';
import { isSendingAllowed } from '../workspaces/abuseGate';
import { loadRouteStateCell, loadStreamlessRouteState } from '../lib/deliverabilityRouteState';
import { recordAuditLog } from '../lib/auditLog';
import {
	nextPhaseCeiling,
	RAMP_INITIAL_PHASE_CEILING,
	RAMP_MAX_FREEZE_MS,
} from './ramp/controllerConfig';
import { readActiveFreeze, type StoredFreeze } from './ramp/controllerReaders';
import { nextShare } from './ramp/controller';
import { nextPaceMultiplier } from './ramp/paceActuator';
import { composeActuators } from './ramp/actuatorComposition';
import { recordMixDecision } from './rampMixDecisions';
import { loadCellInput, resolveRampOrganizationId } from './rampControllerInputs';
import { loadPaceUtilisation, readPaceState } from './rampPaceInputs';
import { loadRampCapacityContext, type RampCapacityContext } from './rampCapacityInputs';
import {
	deliverabilityStreamValidator,
	destinationProviderValidator,
} from './deliverabilityValidators';
import { rampDecisionChangedState } from './ramp/controllerTypes';
import type { RampDecision, RampFreezeOrigin } from './ramp/controllerTypes';
import type { PaceDecision, PaceUtilisationReading } from './ramp/paceTypes';

/** Cells evaluated per tick. The grid is 15; three ticks cover it. */
const RAMP_CELLS_PER_TICK = 5;
/** Route-state rows are refreshed on every tick; the TTL matches the snapshot's. */
const ROUTE_STATE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * KEEP THE CELL'S RAMP STATE ALIVE.
 *
 * `deliverabilityRouteStates` rows carry a 24h `expiresAt` and the shipped
 * 5-minute sweep deletes anything past it. That TTL is right for a cached MTA
 * snapshot; it is WRONG for the durable AIMD state the ramp keeps on the
 * per-stream row (share, phase ceiling, clean streak, graduation clock). A
 * paused controller — or any deploy/outage gap over a day — would otherwise
 * lose the row, and a missing row resolves to share 1.0: the exact opposite of
 * "pinned at its current share".
 *
 * So EVERY evaluation refreshes the lease, including the ones that write no
 * share. The refresh touches nothing else — and in particular NOT `updatedAt`,
 * which is the shipped router's signal-freshness clock and not the ramp's (see
 * `applyDecision`).
 */
async function refreshRouteStateLease(
	ctx: MutationCtx,
	perStream: Doc<'deliverabilityRouteStates'>,
	now: number
): Promise<void> {
	await ctx.db.patch(perStream._id, { expiresAt: now + ROUTE_STATE_TTL_MS });
}

/**
 * THE THREE FREEZE COLUMNS MOVE TOGETHER, or they do not move at all.
 *
 * `freezeStartedAt` (the ladder's anchor), `frozenUntil` (the expiry) and
 * `freezeReason` (which rung it belongs to) are three views of ONE fact, and
 * every defect this write path has had came from computing them separately: an
 * expiry carried forward past a corrupt value, an origin left pointing at the
 * previous incident. Resolving them in one place makes "they agree" a property
 * of the code rather than of three ternaries that happen to line up.
 *
 * THE CARRY-FORWARD TEST IS THE RUNGS' OWN (`readActiveFreeze`), deliberately —
 * not an inline `frozenUntil > now`. Only a freeze the decision function would
 * BELIEVE survives the tick: an expired one is dropped (the pure rung already
 * ignores it, so leaving it on the row would only make the dashboard and the
 * `mix` blob report the cell as frozen until a past instant for ever), and an
 * UNREADABLE one is dropped too. That second case is the whole point: the
 * `freeze_unreadable` rung holds the cell for the tick that reads it, and if the
 * write path carried the unusable instant forward that hold would be permanent
 * rather than one tick, which is neither what the rung's sentence promises nor
 * something an operator could clear.
 */
function resolveFreezeFields(
	stored: StoredFreeze & { freezeStartedAt?: number | undefined },
	decision: { freeze: RampDecision['freeze'] },
	now: number
): {
	freezeStartedAt: number | undefined;
	frozenUntil: number | undefined;
	freezeReason: RampFreezeOrigin | undefined;
} {
	const carried = readActiveFreeze(stored, now, RAMP_MAX_FREEZE_MS);
	const running = carried.kind === 'active' ? carried : undefined;
	const imposed = decision.freeze;
	return {
		// The GATE-COOLDOWN ladder's clock: start, expiry and rung move together,
		// and only a LADDER freeze re-stamps the start. A hard-stop freeze (breaker
		// 6h, critical blocklist 24h) sets the expiry and leaves the ladder's anchor
		// alone — otherwise an infrastructure incident would re-arm the "repeat
		// within 24h" window and double the next gate cooldown off a stale rung.
		freezeStartedAt: imposed?.ladderMs === undefined ? stored.freezeStartedAt : now,
		// A new freeze REPLACES the pair whole. It can only ever be later than the
		// one it replaces — the decision function lengthens rather than shortens
		// (`extendFreezeUntil`) — so the row never loses time it had already been
		// told to serve, and the origin becomes the rung that just fired.
		frozenUntil: imposed?.until ?? running?.until,
		freezeReason: imposed?.origin ?? running?.origin,
	};
}

/**
 * Persist one decision onto the cell's per-stream route-state row.
 *
 * `mixVersion` is NOT touched here. It salts per-recipient assignment (plan
 * D7), so it names a mix GENERATION, not a step: bumping it on an ordinary
 * +5pp promotion would re-shuffle every recipient's arm mid-comparison, ~20
 * times during a single ramp. It advances only on a deliberate generation
 * change (a phase promotion), where re-randomising is the point.
 */
async function applyDecision(
	ctx: MutationCtx,
	args: {
		perStream: Doc<'deliverabilityRouteStates'>;
		decision: RampDecision;
		/** The SECOND actuator's decision, written in the SAME patch — see below. */
		pace: PaceDecision;
		now: number;
	}
): Promise<void> {
	const { perStream, decision, pace, now } = args;
	const fields = {
		isFallbackActive: isFallbackActiveForShare(decision.share),
		ownShare: decision.share,
		phaseCeiling: decision.phaseCeiling,
		cleanStreak: decision.cleanStreak,
		// THE THREE FREEZE COLUMNS, resolved together — see `resolveFreezeFields`.
		// They are one fact: the breaker rung reads the pair to tell its OWN freeze
		// from an unrelated cooldown it must not let absorb its retreat, and an
		// expiry whose origin drifted out of step would answer that question with
		// the last incident's name.
		...resolveFreezeFields(perStream, decision, now),
		cooldownMs: decision.freeze?.ladderMs ?? perStream.cooldownMs,
		greenSince: decision.greenSince,
		graduatedAt: decision.graduatedAt,
		// Only a COUNTED window moves the anchor: an evaluation that did not count
		// must leave the previous one in place, or every hourly tick would push the
		// next countable window another hour out and the streak could never grow.
		lastCountedAt: decision.countedAt ?? perStream.lastCountedAt,
		// NEITHER `snapshotGeneratedAt` NOR `updatedAt` IS TOUCHED, for one reason:
		// both belong to the SNAPSHOT WRITER. `snapshotGeneratedAt` means "the
		// instant the MTA generated the snapshot" and is `applySnapshot`'s
		// idempotency comparand; `updatedAt` is the shipped ROUTER'S SIGNAL-FRESHNESS
		// clock — `routeInputs.ts` only honours a signal on a row it has heard from
		// within `DELIVERABILITY_SIGNAL_MAX_AGE_MS`, and the per-stream row is in
		// that scan. An hourly controller stamping it would silently re-arm every
		// signal on the row as "fresh" on every tick, indefinitely. The controller's
		// own clock is `decidedAt`, which nothing else reads.
		decidedAt: now,
		expiresAt: now + ROUTE_STATE_TTL_MS,
		// THE SECOND ACTUATOR'S COLUMNS, in the SAME patch and never a second one.
		// One controller decided both dials from one set of gates in one tick, so
		// one write applies both: two patches would leave a window in which the row
		// carried a share from this tick and a pace from the last.
		...paceFields(perStream, pace, now),
	};
	await ctx.db.patch(perStream._id, fields);
}

/**
 * The pace dial's half of the row.
 *
 * THE FREEZE COLUMNS ARE THE PACE ACTUATOR'S OWN and are resolved by the SAME
 * rule as the share's (`resolveFreezeFields`), reading the pace triple rather
 * than the share triple: the two dials retreat independently, and one column
 * shared between them would let a share cooldown suppress a pace retreat for a
 * reason the pace gates never measured.
 *
 * `paceLastEvaluatedUtcDay` MOVES ONLY ON A COUNTED DAY (plan D19). An
 * evaluation that held — thin evidence, an unexercised cap, or the composition
 * interlock deferring the step — deliberately leaves the anchor where it found
 * it, so a later tick the same day can still evaluate that day once.
 */
interface PaceRowFields {
	paceMultiplier: number;
	paceCleanStreak: number;
	paceFrozenUntil: number | undefined;
	paceFreezeStartedAt: number | undefined;
	paceFreezeReason: RampFreezeOrigin | undefined;
	paceCooldownMs: number | undefined;
	paceLastEvaluatedUtcDay: string | undefined;
}

function paceFields(
	perStream: Doc<'deliverabilityRouteStates'>,
	pace: PaceDecision,
	now: number
): PaceRowFields {
	const stored = {
		frozenUntil: perStream.paceFrozenUntil,
		freezeReason: perStream.paceFreezeReason,
		freezeStartedAt: perStream.paceFreezeStartedAt,
	};
	const freeze = resolveFreezeFields(stored, { freeze: pace.freeze }, now);
	return {
		paceMultiplier: pace.multiplier,
		paceCleanStreak: pace.cleanStreak,
		paceFrozenUntil: freeze.frozenUntil,
		paceFreezeStartedAt: freeze.freezeStartedAt,
		paceFreezeReason: freeze.freezeReason,
		paceCooldownMs: pace.freeze?.ladderMs ?? perStream.paceCooldownMs,
		paceLastEvaluatedUtcDay: pace.countedUtcDay ?? perStream.paceLastEvaluatedUtcDay,
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

		const slice = cells.slice(cursor, cursor + RAMP_CELLS_PER_TICK);
		let evaluated = 0;
		for (const cell of slice) {
			const loaded = await loadCellInput(ctx, {
				organizationId,
				cell,
				pool,
				capacity,
				isKillSwitchEngaged,
				isSendingPermitted,
				now,
			});
			// An unmanaged cell is not an evaluation: there is no share to decide
			// about, and inventing one would change shipped routing.
			if (loaded === null) continue;
			const { input, perStream } = loaded;
			const decision = nextShare(input);
			// THE SECOND ACTUATOR, on the SAME gates, the SAME hard stops and the
			// SAME kill switch (plan D3). Standalone it is the only dial that moves —
			// s === 1 by definition — and with a reference arm it is the slow,
			// reputation-bearing half of a composed decision.
			const paceReading = await utilisation();
			const paceDecision = nextPaceMultiplier({
				config: input.config,
				pace: readPaceState(perStream),
				signals: input.signals,
				evaluation: input.evaluation,
				utilisation: paceReading,
				isKillSwitchEngaged,
				now,
			});
			// THE COMPOSITION ORDER IS FIXED (plan D3): share moves FIRST (cheap and
			// instantly reversible — the relay absorbs the difference), pace moves
			// SECOND (slow and reputation-bearing), and a cell may NEVER increase both
			// in one window. The interlock lives in one pure function so that
			// property is a fixture rather than an inline conditional here.
			const composed = composeActuators({ share: decision, pace: paceDecision });
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

			await applyDecision(ctx, { perStream, decision, pace: composed.pace, now });
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
			const isPaceChanged =
				composed.pace.multiplier !== composed.pace.fromMultiplier ||
				composed.pace.freeze?.ladderMs !== undefined;
			if (!rampDecisionChangedState(decision) && !isPaceChanged) continue;
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

/**
 * Promote a cell one rung up the phase ladder (0.25 -> 0.5 -> 0.8 -> 1.0). A
 * deliberate act, never something the hourly AIMD loop does on its own: the
 * ladder exists precisely so that the biggest steps stay human-authorised.
 *
 * A promotion IS a new mix generation, so it is also the one place that
 * advances `mixVersion` (plan D7): the cohort is deliberately re-randomised
 * when the phase changes, and never on an ordinary AIMD step.
 *
 * THE GLOBAL KILL SWITCH PINS THIS TOO. The switch's contract is that no cell
 * moves while it is engaged, and a promotion moves two things that matter most
 * during an incident: it raises the phase ceiling, and it re-shuffles which arm
 * EVERY recipient of the cell lands in. "Everything held still" has to mean
 * everything, so a paused controller refuses the promotion rather than applying
 * it quietly while the AIMD loop is frozen.
 */
export const promoteRampPhase = internalMutation({
	args: {
		stream: deliverabilityStreamValidator,
		destinationProvider: destinationProviderValidator,
	},
	handler: async (ctx, args) => {
		const cell: DeliverabilityCell = {
			stream: args.stream,
			destinationProvider: args.destinationProvider,
		};
		const settings = await ctx.db.query('instanceSettings').first();
		if (settings?.isRampControllerPaused === true) return { ok: false as const };
		const organizationId = await resolveRampOrganizationId(ctx);
		if (organizationId === null) return { ok: false as const };
		const { perStream } = await loadRouteStateCell(ctx, organizationId, cell);
		if (!perStream) return { ok: false as const };
		// One rung, through the ladder helper: an arbitrary caller-supplied ceiling
		// would let a promotion skip 0.5 and 0.8 straight to 1.0.
		const current = perStream.phaseCeiling ?? RAMP_INITIAL_PHASE_CEILING;
		const phaseCeiling = nextPhaseCeiling(current);
		// Already at the top rung: nothing to promote, and re-randomising the
		// cohort for a no-op would cost the comparison its continuity for nothing.
		if (phaseCeiling === current) return { ok: true as const, phaseCeiling };
		await ctx.db.patch(perStream._id, {
			phaseCeiling,
			mixVersion: (perStream.mixVersion ?? 0) + 1,
			// The ramp's own clock, never the router's freshness clock — see
			// `applyDecision`.
			decidedAt: Date.now(),
		});
		return { ok: true as const, phaseCeiling };
	},
});
