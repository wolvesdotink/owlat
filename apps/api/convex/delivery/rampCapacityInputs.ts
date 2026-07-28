/**
 * THE CAPACITY READ (plan P3-3) — where the controller's ceiling gets its two
 * numbers.
 *
 * `rampControllerInputs.ts` builds one cell's decision input; this module builds
 * the ONE capacity reading the whole tick shares, because the bound is
 * deployment-level by derivation rather than by approximation:
 *
 *   own-arm volume = sum over cells of (share_c x demand_c) <= headroom
 *   ⇒ share_c <= headroom / sum(demand_c)   for every cell
 *
 * The shipped warming sync reports headroom for the CAMPAIGN POOL, not per
 * (IP x mailbox provider) — one number, shared by every cell it governs — so a
 * ceiling divided by ONE cell's demand would let all of them promise the cap
 * over and over. The denominator is the projected demand of the cells that pool
 * actually carries, summed over PER-CELL projections (`projectCellVolume`), and
 * the ceiling that comes out is legitimately the same for each of them.
 *
 * WHICH POOL THE BOUND GOVERNS, AND THEREFORE WHICH CELLS IT BINDS.
 * `loadWarmingCapacity` sums `ip.active && ip.pool === 'campaign'` — CAMPAIGN
 * POOL headroom, nothing else. The numerator and the denominator must describe
 * the same population, so the denominator sums only the streams that dispatch
 * through that pool: `campaign` and `automation`. The `transactional` stream is
 * excluded on both sides — every transactional dispatch site in this codebase
 * (`systemMail`, `mail/outbound`, `mail/deliveryHooks`) sends `ipPool:
 * 'transactional'`, and the MTA adapter's default is `'transactional'` too — so
 * a transactional cell is NOT bounded by this reading at all. Bounding it by a
 * cap that does not govern it would throttle the stream the plan (D6) wants to
 * ramp last and fastest, for no measured reason.
 *
 * That also stops the plan's SAFETY = 0.8 double-counting itself. The 20% it
 * holds back is explicitly the reserve for TRANSACTIONAL BURSTS against the
 * shared IPs; summing transactional demand into the denominator as well would
 * charge that traffic to the ramp twice.
 *
 * NOTHING HERE DECIDES ANYTHING. Every rule lives in `delivery/ramp/`: the
 * projection statistic, the zero-demand refusal and the end-of-day guard are all
 * in `ramp/capacityProjection.ts`, and the arithmetic is `ramp/controllerBounds`.
 * This module reads rows and hands them over.
 *
 * READ COST. One `warmingState` row plus two bounded index reads per governed
 * cell — the cell's own and reference outcome shards over eight UTC days —
 * issued CONCURRENTLY, because the cells are independent. The alternative was
 * plumbing a demand total through the cursor chain and keeping a second, staler
 * source of truth for it. The reading is also taken LAZILY — `capacityInputForCell`
 * takes a THUNK and resolves it only after the cell is known to be governed — so
 * a slice with no ramp-managed cell in it (the normal state during rollout, plan
 * D1), and a slice of transactional cells (which the stream-major cell order
 * produces exactly), never ask for it at all.
 *
 * ABSENCE IS A SUPPORTED CONFIGURATION (plan D2). No warming state, a stale
 * sync, a graduated pool: every one of them answers `unconstrained` — the cell
 * is bounded by its phase ceiling and by its gates, exactly as before this piece
 * landed. A missing reading is never evidence of a full cap.
 */

import {
	allDeliverabilityCells,
	deliverabilityCellKey,
	type DeliverabilityCell,
	type DeliverabilityCellKey,
	type DeliverabilityStream,
} from '@owlat/shared/deliverabilityRouting';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { MS_PER_DAY } from '../lib/constants';
import { startOfDayUtc } from '../lib/clock';
import { readCellArmBuckets } from '../analytics/transportOutcomes';
import { safeOutcomeCount } from '../analytics/transportOutcomeSummary';
import {
	CAPACITY_TRAILING_DAYS,
	deliveredShareShortfall,
	projectCellVolume,
	remainingDemandToday,
	type CellVolumeDay,
	type CellVolumeProjection,
	type CellVolumeUnknownReason,
} from './ramp/capacityProjection';
import { loadWarmingCapacity } from './warmingCapacity';
import type { RampCapacityInput, RampCapacityUnknownReason } from './ramp/controllerTypes';

type Ctx = MutationCtx | QueryCtx;

/**
 * One tick's capacity reading: the shared bound, plus the per-cell projections
 * that produced it so each cell's audit row can carry its own evidence.
 */
export interface RampCapacityContext {
	readonly base: RampCapacityInput;
	readonly projections: ReadonlyMap<DeliverabilityCellKey, CellVolumeProjection>;
}

/** The reading a deployment with no usable warming state gets (plan D2). */
const UNCONSTRAINED_CAPACITY: RampCapacityInput = { kind: 'unconstrained' };

/**
 * The streams the CAMPAIGN warming pool carries, and therefore the only cells
 * this bound may bind or be divided by. See the module doc for why
 * `transactional` is on neither side of the ratio.
 */
const CAMPAIGN_POOL_STREAMS: readonly DeliverabilityStream[] = ['campaign', 'automation'];

function isCampaignPoolCell(cell: DeliverabilityCell): boolean {
	return CAMPAIGN_POOL_STREAMS.includes(cell.stream);
}

/**
 * One cell's trailing days, from the shard rows of BOTH arms.
 *
 * The own arm contributes to `total` as well as to `own`: `total` is the cell's
 * demand, whichever transport carried it. Days are aggregated downstream by
 * `projectCellVolume`, so the per-shard rows go over as they are read.
 */
async function readCellVolumeDays(
	ctx: Ctx,
	args: { organizationId: string; cell: DeliverabilityCellKey; since: number }
): Promise<CellVolumeDay[]> {
	const [own, reference] = await Promise.all([
		readCellArmBuckets(ctx.db, { ...args, arm: 'own' }),
		readCellArmBuckets(ctx.db, { ...args, arm: 'reference' }),
	]);
	const days: CellVolumeDay[] = [];
	for (const bucket of own) {
		const sent = safeOutcomeCount(bucket.sent);
		days.push({ dayStartMs: bucket.periodStart, total: sent, own: sent });
	}
	for (const bucket of reference) {
		days.push({ dayStartMs: bucket.periodStart, total: safeOutcomeCount(bucket.sent), own: 0 });
	}
	return days;
}

/**
 * THE REASON THE CELLS AGREE ON, or the generic one when they do not.
 *
 * D12 wants an operator told WHY, not merely that. "Every governed cell has
 * never sent" (`no_history`) and "every governed cell is paused"
 * (`no_volume`) are different situations with different responses, and both are
 * lost if the tick reports one hardcoded string. A mixed set has no single true
 * answer, so it reports the generic one honestly instead of picking a winner.
 *
 * The parameter is the UNKNOWN reasons only: a cell that projected contributes
 * no reason, and the caller reaches this function only when NO cell projected,
 * so the "one shared reason or the generic one" shape is the whole domain.
 */
function sharedUnknownReason(
	reasons: readonly CellVolumeUnknownReason[]
): RampCapacityUnknownReason {
	const [first] = reasons;
	if (first === undefined) return 'demand_unprojectable';
	for (const reason of reasons) {
		if (reason !== first) return 'demand_unprojectable';
	}
	return first;
}

/**
 * Build the tick's capacity reading. Reads only; decides nothing.
 *
 * The order of the two refusals matters. NO WARMING READING is checked first and
 * answers `unconstrained`, because a cell whose cap we cannot see is not a cell
 * whose cap is spent (plan D2). Only once a cap IS known does an unusable demand
 * projection become a HOLD: there is a real bound to apply and no denominator to
 * apply it with.
 */
export async function loadRampCapacityContext(
	ctx: Ctx,
	args: { organizationId: string; now: number }
): Promise<RampCapacityContext> {
	const { organizationId, now } = args;
	const projections = new Map<DeliverabilityCellKey, CellVolumeProjection>();

	const warming = await loadWarmingCapacity(ctx, { now });
	if (warming === null) return { base: UNCONSTRAINED_CAPACITY, projections };

	// One extra day of slack on the lower bound: `readCellArmBuckets` floors it to
	// a UTC day, and the projection re-applies the exact window itself.
	const since = startOfDayUtc(now) - (CAPACITY_TRAILING_DAYS + 1) * MS_PER_DAY;
	// THE CELLS ARE INDEPENDENT, so their reads are issued together rather than
	// one round trip after another: the loop this replaces paid a serial trip per
	// cell for a reading no cell's answer depends on.
	const governed = allDeliverabilityCells().filter(isCampaignPoolCell);
	const projected = await Promise.all(
		governed.map(async (cell) => {
			const key = deliverabilityCellKey(cell);
			const days = await readCellVolumeDays(ctx, { organizationId, cell: key, since });
			return [key, projectCellVolume(days, now)] as const;
		})
	);
	let projectedVolume = 0;
	const unknownReasons: CellVolumeUnknownReason[] = [];
	for (const [key, projection] of projected) {
		projections.set(key, projection);
		if (projection.kind === 'projected') projectedVolume += projection.dailyVolume;
		else unknownReasons.push(projection.reason);
	}

	// NO GOVERNED CELL PROJECTED ANYTHING is its own answer, told apart from the
	// end-of-day refusal below so the audit row can say which it was (plan D12).
	// When every governed cell agrees on WHY — a brand-new deployment, a paused
	// week — that reason is carried through verbatim rather than flattened.
	if (!(projectedVolume > 0)) {
		return { base: { kind: 'unknown', reason: sharedUnknownReason(unknownReasons) }, projections };
	}

	// The remaining day's demand against the remaining day's cap — like for like,
	// so the ceiling does not sawtooth through every afternoon.
	const demandAhead = remainingDemandToday(projectedVolume, now);
	if (demandAhead === null) {
		return { base: { kind: 'unknown', reason: 'day_almost_over' }, projections };
	}
	return {
		base: {
			kind: 'projected',
			warmingCapRemaining: warming.remainingToday,
			projectedVolume: demandAhead,
		},
		projections,
	};
}

/**
 * The capacity input for ONE cell: the tick's shared bound, plus that cell's own
 * trailing evidence for the audit snapshot (plan D12). The evidence changes no
 * rung — `capacityCeiling` reads the two numbers and nothing else.
 */
export async function capacityInputForCell(
	context: () => Promise<RampCapacityContext>,
	cell: DeliverabilityCell,
	currentShare: number
): Promise<RampCapacityInput> {
	// A CELL THE CAMPAIGN POOL DOES NOT CARRY IS NOT BOUNDED BY ITS CAP. The
	// transactional stream dispatches through the transactional pool, so this
	// reading says nothing about it — and a reading that says nothing constrains
	// nothing (plan D2). Its phase ceiling and its gates still bind.
	//
	// THE CONTEXT IS A THUNK so that this check happens BEFORE the reading is
	// taken: `allDeliverabilityCells()` is stream-major, so a whole cursor slice
	// can be transactional, and such a slice must not pay for a reading no cell
	// in it consults. Which cells the campaign pool governs is known here and
	// nowhere else, so the laziness is resolved here too.
	if (!isCampaignPoolCell(cell)) return UNCONSTRAINED_CAPACITY;
	const { base, projections } = await context();
	const projection = projections.get(deliverabilityCellKey(cell));
	// THE CELL'S OWN REASON BEATS THE TICK'S. When the deployment could not be
	// projected, the audit row should say whether THIS cell is brand-new, paused
	// or clock-broken rather than repeating the aggregate verdict (plan D12).
	if (base.kind === 'unknown') {
		return projection?.kind === 'unknown' ? { kind: 'unknown', reason: projection.reason } : base;
	}
	if (base.kind !== 'projected') return base;
	if (projection === undefined || projection.kind !== 'projected') return base;
	return {
		...base,
		cellEvidence: {
			projectedCellVolume: projection.dailyVolume,
			observedDays: projection.observedDays,
			ownFraction: projection.ownFraction,
			deliveredShareShortfall: deliveredShareShortfall(projection, currentShare),
		},
	};
}
