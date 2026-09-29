/**
 * Per-cell, per-arm day buckets: the plumbing every such counter shares.
 *
 * `analytics/transportOutcomes.ts` and `analytics/smtpResponseCategories.ts`
 * both keep one sharded row per (org, cell, arm, day). The deliverability gate
 * reads the two side by side over the same windows, so their shard count,
 * retention horizon, window range and send → (cell, arm) join must stay equal.
 * They live here once instead of being restated in each module under a comment
 * that says they must match.
 *
 * What stays in each metric module is its counter semantics: which table it
 * reads, what a row counts, how rows are summarized and how one is bumped.
 */

import {
	deliverabilityCellKey,
	parseDeliverabilityCellKey,
	type DeliverabilityCellKey,
} from '@owlat/shared/deliverabilityRouting';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { getSingletonOrganizationId } from '../lib/sessionOrganization';
import { readAssignmentForSend } from '../delivery/sendAssignments';
import {
	transportOutcomeWindowBounds,
	type TransportOutcomeArm,
	type TransportOutcomeWindow,
} from './transportOutcomeSummary';

// ============ CONSTANTS ============

/**
 * Write-shard count per (org, cell, arm, day) bucket, the same knob, for the
 * same reason, as `sendingReputation`'s. Each event bumps one random shard, so a
 * blast spreads its read-modify-writes across 8 documents instead of contending
 * on one. Purely write-side: every summarizer sums across all shards.
 */
export const CELL_ARM_BUCKET_SHARD_COUNT = 8;

/**
 * Buckets age out after 90 days, the `sendAssignments` retention horizon. One
 * value for every per-cell counter: they are read side by side, and a shorter
 * horizon on one would let a cell's evidence expire while the numbers it is
 * judged beside remain.
 */
export const CELL_ARM_BUCKET_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** Rows deleted per aging tick; the sweep re-schedules itself while full. */
export const CELL_ARM_BUCKET_CLEANUP_BATCH_SIZE = 200;

/** One random shard key in `[0, CELL_ARM_BUCKET_SHARD_COUNT)`. */
export function randomCellArmShardKey(): number {
	// Mutations may use `Math.random`; only the workflow runtime forbids it.
	return Math.floor(Math.random() * CELL_ARM_BUCKET_SHARD_COUNT);
}

// ============ READ SIDE ============

/** One (org, cell, arm) window, the argument every bucket reader takes. */
export interface CellArmWindowQuery extends TransportOutcomeWindow {
	readonly organizationId: string;
	readonly cell: DeliverabilityCellKey;
	readonly arm: TransportOutcomeArm;
}

/**
 * The `periodStart` range to hand the `by_org_cell_arm_period_shard` index for
 * a window: `gte(lower)` and `lt(upper)`.
 *
 * One range expression, not a branch per bound: an unbounded side becomes a
 * sentinel no real bucket day can fall outside of (`periodStart` is always a
 * finite UTC day timestamp). The exact window filter is re-applied by the pure
 * summarizers, so a sentinel can never widen the answer.
 */
export function cellArmPeriodRange(window: TransportOutcomeWindow | undefined): {
	lower: number;
	upper: number;
} {
	const { sinceDay, until } = transportOutcomeWindowBounds(window);
	return {
		lower: Number.isFinite(sinceDay) ? sinceDay : 0,
		upper: Number.isFinite(until) ? until : Number.MAX_SAFE_INTEGER,
	};
}

// ============ THE SEND → (CELL, ARM) JOIN ============

export type CellArmResolution =
	| {
			readonly ok: true;
			readonly organizationId: string;
			readonly cell: DeliverabilityCellKey;
			readonly arm: TransportOutcomeArm;
			readonly isCalibration: boolean;
	  }
	| { readonly ok: false; readonly reason: 'no_organization' | 'no_assignment' | 'invalid_cell' };

/**
 * Learn the (cell, arm, isCalibration) a send was assigned to, through its
 * `sendAssignments` row. The arm is a property of the assignment and of nothing
 * else, so every per-cell counter joins here rather than deriving it.
 *
 * FAIL-SOFT: a miss is returned, never thrown. A send with no assignment row (a
 * seed shadow copy, a legacy send, a member preview) is outside the experiment
 * and must never enter a denominator.
 */
export async function resolveCellArmForSend(
	ctx: QueryCtx | MutationCtx,
	sendId: string
): Promise<CellArmResolution> {
	let organizationId: string;
	try {
		organizationId = await getSingletonOrganizationId(ctx);
	} catch {
		return { ok: false, reason: 'no_organization' };
	}

	// THE tenant-scoped join, shared with every other reader of the row.
	const assignment = await readAssignmentForSend(ctx.db, organizationId, sendId);
	if (!assignment) return { ok: false, reason: 'no_assignment' };

	// `cell` is a plain string in the schema; a malformed one would create a
	// bucket no reader can ever address. Parse ONCE here and hand the branded,
	// re-canonicalized key down, so a variant spelling can neither reach a
	// bucket nor be invented by a caller.
	const parsedCell = parseDeliverabilityCellKey(assignment.cell);
	if (parsedCell === null) return { ok: false, reason: 'invalid_cell' };

	return {
		ok: true,
		organizationId,
		cell: deliverabilityCellKey(parsedCell),
		arm: assignment.arm,
		isCalibration: assignment.isCalibration,
	};
}
