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
 * (IP x mailbox provider) — one number, shared by all fifteen cells — so a
 * ceiling divided by ONE cell's demand would let the fifteen of them promise
 * fifteen times the cap. The denominator is the deployment's projected demand,
 * summed over PER-CELL projections (`projectCellVolume`), and the ceiling that
 * comes out is legitimately the same for every cell.
 *
 * NOTHING HERE DECIDES ANYTHING. Every rule lives in `delivery/ramp/`: the
 * projection statistic, the zero-demand refusal and the end-of-day guard are all
 * in `ramp/capacityProjection.ts`, and the arithmetic is `ramp/controllerBounds`.
 * This module reads rows and hands them over.
 *
 * READ COST. One `warmingState` row plus two bounded index reads per cell — the
 * cell's own and reference outcome shards over eight UTC days. The cron ticks
 * hourly in three slices, so this is thirty bounded reads three times an hour on
 * a background mutation, against the alternative of plumbing a demand total
 * through the cursor chain and having a second, staler source of truth for it.
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
} from '@owlat/shared/deliverabilityRouting';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { MS_PER_DAY } from '../lib/constants';
import { startOfDayUtc } from '../lib/clock';
import { readCellArmBuckets } from '../analytics/transportOutcomes';
import { safeOutcomeCount } from '../analytics/transportOutcomeSummary';
import {
	CAPACITY_TRAILING_DAYS,
	projectCellVolume,
	remainingDemandToday,
	rerouteMissRate,
	type CellVolumeDay,
	type CellVolumeProjection,
} from './ramp/capacityProjection';
import { loadWarmingCapacity } from './warmingCapacity';
import type { RampCapacityInput } from './ramp/controllerTypes';

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
export const UNCONSTRAINED_CAPACITY: RampCapacityInput = { kind: 'unconstrained' };

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
	let projectedVolume = 0;
	for (const cell of allDeliverabilityCells()) {
		const key = deliverabilityCellKey(cell);
		const projection = projectCellVolume(
			await readCellVolumeDays(ctx, { organizationId, cell: key, since }),
			now
		);
		projections.set(key, projection);
		if (projection.kind === 'projected') projectedVolume += projection.dailyVolume;
	}

	// The remaining day's demand against the remaining day's cap — like for like,
	// so the ceiling does not sawtooth through every afternoon.
	const demandAhead = remainingDemandToday(projectedVolume, now);
	if (demandAhead === null) {
		return { base: { kind: 'unknown', reason: 'demand_unprojectable' }, projections };
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
export function capacityInputForCell(
	context: RampCapacityContext,
	cell: DeliverabilityCell,
	assignedShare: number
): RampCapacityInput {
	const { base } = context;
	if (base.kind !== 'projected') return base;
	const projection = context.projections.get(deliverabilityCellKey(cell));
	if (projection === undefined || projection.kind !== 'projected') return base;
	return {
		...base,
		cellEvidence: {
			projectedCellVolume: projection.dailyVolume,
			observedDays: projection.observedDays,
			ownFraction: projection.ownFraction,
			missRate: rerouteMissRate(projection, assignedShare),
		},
	};
}
