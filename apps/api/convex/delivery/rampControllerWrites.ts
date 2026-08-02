/**
 * THE RAMP CONTROLLER'S WRITE PATH — the only place a decision becomes a row.
 *
 * Split out of `rampControllerCron.ts` so the cron is the SHELL the plan says it
 * is (D15: load, call the pure functions, write): the read half already lives in
 * `rampControllerInputs.ts`, and this is its sibling on the way out. Nothing
 * here decides anything — every value written was produced by a pure decision
 * function upstream.
 *
 * ONE PATCH PER EVALUATION. Both actuators' columns are resolved here and
 * applied together (see `applyDecision`): two patches would leave a window in
 * which the row carried a share from this tick and a pace from the last.
 */

import type { Doc } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { isFallbackActiveForShare } from '@owlat/shared/deliverabilityRouting';
import { RAMP_MAX_FREEZE_MS } from './ramp/controllerConfig';
import { readActiveFreeze, type StoredFreeze } from './ramp/controllerReaders';
import type { RampDecision, RampFreezeOrigin } from './ramp/controllerTypes';
import type { PaceDecision } from './ramp/paceTypes';

/**
 * Route-state rows are refreshed on every tick; the TTL matches the snapshot's.
 *
 * Exported because ENROLMENT writes the first lease a cell's row ever gets, and
 * a second constant there would let a newly-enrolled row expire on a different
 * clock from the one every later tick renews it on.
 */
export const ROUTE_STATE_TTL_MS = 24 * 60 * 60 * 1000;

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
export async function refreshRouteStateLease(
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
export async function applyDecision(
	ctx: MutationCtx,
	args: {
		perStream: Doc<'deliverabilityRouteStates'>;
		decision: RampDecision;
		/** The SECOND actuator's decision, written in the SAME patch — see below. */
		pace: PaceDecision;
		/** Did the composition interlock withhold a pace increase on THIS tick? */
		isPaceDeferred: boolean;
		now: number;
	}
): Promise<void> {
	const { perStream, decision, pace, isPaceDeferred, now } = args;
	const fields = {
		...shareFields(perStream, decision, now),
		// The controller's own clock. Neither `snapshotGeneratedAt` nor `updatedAt`
		// is touched — see `shareFields` for why.
		decidedAt: now,
		expiresAt: now + ROUTE_STATE_TTL_MS,
		// THE SECOND ACTUATOR'S COLUMNS, in the SAME patch and never a second one.
		// One controller decided both dials from one set of gates in one tick, so
		// one write applies both: two patches would leave a window in which the row
		// carried a share from this tick and a pace from the last.
		...paceFields(perStream, pace, isPaceDeferred, now),
	};
	await ctx.db.patch(perStream._id, fields);
}

/** The share dial's half of the row. */
function shareFields(
	perStream: Doc<'deliverabilityRouteStates'>,
	decision: RampDecision,
	now: number
) {
	return {
		isFallbackActive: isFallbackActiveForShare(decision.share),
		ownShare: decision.share,
		phaseCeiling: decision.phaseCeiling,
		// THE DWELL ANCHOR, BACKFILLED ONCE AND NEVER MOVED HERE.
		//
		// Only the writes that SET a rung stamp this (enrolment, a promotion, a
		// downward phase reset), so a row that reached its rung any other way
		// (seeded, hand-patched, or written before the column existed) would carry
		// none — and dwell is one of the four conditions on the
		// standalone promotion route, the ONLY route a yahoo/apple/other cell has.
		// Left absent, that cell could never be promoted again by anyone. Adopting
		// the row's creation instant (never `now`, which would restart the dwell on
		// every hourly tick) makes the anchor explicit and stable, and matches what
		// `loadRampPromotionEvidence` falls back to for a row it has not yet seen.
		phaseCeilingSince: perStream.phaseCeilingSince ?? perStream._creationTime,
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
	};
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
 *
 * `paceDeferredAt` IS THE INTERLOCK'S MEMORY (plan D3). It is stamped on the
 * tick the interlock fired and left alone otherwise — including on the tick that
 * finally takes the deferred step, because the rung that reads it is written
 * against elapsed time and not against a flag anyone has to remember to clear.
 */
interface PaceRowFields {
	paceMultiplier: number;
	paceCleanStreak: number;
	paceFrozenUntil: number | undefined;
	paceFreezeStartedAt: number | undefined;
	paceFreezeReason: RampFreezeOrigin | undefined;
	paceCooldownMs: number | undefined;
	paceLastEvaluatedUtcDay: string | undefined;
	paceDeferredAt: number | undefined;
}

function paceFields(
	perStream: Doc<'deliverabilityRouteStates'>,
	pace: PaceDecision,
	isPaceDeferred: boolean,
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
		paceDeferredAt: isPaceDeferred ? now : perStream.paceDeferredAt,
	};
}
