/**
 * Settling an admission hold against the ledger (ADR-0073, Phase 1b).
 *
 * Settled spend lives only in `llmUsageEvents`. A hold is closed by reading
 * the ledger rows that ran under it (`by_reservation_id`) and, when some of
 * that spend is unknown, writing ONE conservative estimate row through the
 * ledger's only insert (`insertLlmUsage`, which also counts it in the period
 * aggregate). Then the hold leaves `held`. Never a second increment, never a
 * hold summed as spend.
 *
 * Two modes:
 *
 * - `call_end`: the dispatch that held it is over and has written its rows. A
 *   request with no reported usage (a zero-cost row marked `isEstimated`, not
 *   a local engine) is charged its OWN bound: the amount reserved for that
 *   request (`requestBounds`, keyed by request id and attempt), or, for a hold
 *   that recorded no per-request bound, the largest bound it has. It was sent,
 *   and the provider may have billed it. A hold whose rows are not all in yet
 *   (`expectedRequests`) stays held: a batch still on its way through the
 *   scheduler would otherwise be charged twice. No request at all releases it.
 * - `expired`: the action died between dispatch and settlement (or its rows
 *   never arrived). Nothing says how much of the path ran, so the whole hold
 *   is charged, less what the ledger already has.
 *
 * LATE ROWS. A request row can still arrive after its hold closed (a batch the
 * scheduler delivered after the sweep). {@link reconcileLateRow} runs in the
 * mutation that inserts it: the row is charged against the part of the
 * estimate it replaces (`estimateRemainingMicrousd`) with a negative
 * adjustment row, so the hold's final charge is max(estimate, reported) and
 * nothing is counted twice.
 *
 * Idempotent: a hold that is not `held` is left alone by settlement, so a
 * repeated settle, a settle racing the sweep, or a retried batch changes nothing.
 */

import type { Doc } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { insertLlmUsage, ZERO_USAGE } from '../analytics/ledgerInsert';
import { ledgerRowMicrousd } from '../lib/aiRouting/spendPeriods';

/** The feature tag of a settlement's estimate and adjustment rows (the dashboard groups by it). */
export const SETTLEMENT_FEATURE = 'admission_settlement';

/** Rows read per hold: one per provider request, which a hold bounds well below this. */
const MAX_SETTLEMENT_ROWS = 512;

export type SettleMode =
	| { readonly mode: 'call_end'; readonly expectedRequests: number }
	| { readonly mode: 'expired' };

/** A request whose usage nobody reported: sent, maybe billed, priced at zero. */
function isUnknownUsage(row: Doc<'llmUsageEvents'>): boolean {
	return (
		row.feature !== SETTLEMENT_FEATURE &&
		row.isEstimated === true &&
		ledgerRowMicrousd(row) === 0 &&
		row.isLocalEngine !== true
	);
}

/** The amount reserved for the request a row records, or the hold's largest request bound. */
export function requestBoundOf(
	hold: Pick<Doc<'llmReservations'>, 'requestBounds' | 'heldMicrousd' | 'maxAttempts'>,
	row: { readonly requestId?: string; readonly attempt?: number }
): number {
	const bounds = hold.requestBounds ?? [];
	const own = bounds.find(
		(bound) =>
			bound.requestId !== undefined &&
			bound.requestId === row.requestId &&
			bound.attempt === row.attempt
	);
	if (own) return own.microusd;
	const largest = bounds.reduce((max, bound) => Math.max(max, bound.microusd), 0);
	// A hold from before per-request bounds: its average request.
	return largest > 0 ? largest : Math.ceil(hold.heldMicrousd / Math.max(1, hold.maxAttempts));
}

export type SettleOutcome = 'settled' | 'released' | 'expired' | 'pending' | 'not_held';

/** Settle one hold, in the caller's mutation. */
export async function settleReservation(
	ctx: MutationCtx,
	reservationId: string,
	how: SettleMode,
	now: number = Date.now()
): Promise<SettleOutcome> {
	const hold = await holdById(ctx, reservationId);
	if (!hold || hold.status !== 'held') return 'not_held';
	const rows = await ctx.db
		.query('llmUsageEvents')
		.withIndex('by_reservation_id', (q) => q.eq('reservationId', reservationId))
		.take(MAX_SETTLEMENT_ROWS);
	const requestRows = rows.filter((row) => row.feature !== SETTLEMENT_FEATURE);
	const reported = rows
		.filter((row) => !isUnknownUsage(row))
		.reduce((sum, row) => sum + ledgerRowMicrousd(row), 0);

	let charge: number;
	let status: 'settled' | 'released' | 'expired';
	if (how.mode === 'call_end') {
		if (requestRows.length < how.expectedRequests) return 'pending';
		if (requestRows.length === 0) {
			await ctx.db.patch(hold._id, { status: 'released', settledMicrousd: 0, updatedAt: now });
			return 'released';
		}
		charge = rows.filter(isUnknownUsage).reduce((sum, row) => sum + requestBoundOf(hold, row), 0);
		status = 'settled';
	} else {
		charge = Math.max(0, hold.heldMicrousd - reported);
		status = 'expired';
	}

	if (charge > 0) await writeAdjustment(ctx, hold, charge, 'estimate');
	await ctx.db.patch(hold._id, {
		status,
		settledMicrousd: reported + charge,
		estimateRemainingMicrousd: charge,
		updatedAt: now,
	});
	return status;
}

/**
 * A request row of `reservationId` was just inserted, in this mutation. When
 * the hold already closed with an estimate, charge the row against what of the
 * estimate it replaces: a negative adjustment of min(row, remaining), so the
 * hold's final charge is max(estimate, reported). A row of unknown usage adds
 * nothing (the estimate already covers it). A held reservation is untouched:
 * its settlement reads the row.
 */
export async function reconcileLateRow(
	ctx: MutationCtx,
	reservationId: string,
	row: { readonly costMicrousd: number; readonly isUnknownUsage: boolean },
	now: number = Date.now()
): Promise<void> {
	const hold = await holdById(ctx, reservationId);
	if (!hold || hold.status === 'held') return;
	if (row.isUnknownUsage || row.costMicrousd <= 0) return;
	const remaining = hold.estimateRemainingMicrousd ?? 0;
	const offset = Math.min(row.costMicrousd, remaining);
	if (offset > 0) await writeAdjustment(ctx, hold, -offset, 'offset');
	await ctx.db.patch(hold._id, {
		estimateRemainingMicrousd: remaining - offset,
		settledMicrousd: (hold.settledMicrousd ?? 0) + row.costMicrousd - offset,
		updatedAt: now,
	});
}

function holdById(ctx: MutationCtx, reservationId: string) {
	return ctx.db
		.query('llmReservations')
		.withIndex('by_reservation_id', (q) => q.eq('reservationId', reservationId))
		.first();
}

/** One settlement row through the ledger's only insert: an estimate, or an offset of one. */
async function writeAdjustment(
	ctx: MutationCtx,
	hold: Doc<'llmReservations'>,
	microusd: number,
	kind: 'estimate' | 'offset'
): Promise<void> {
	await insertLlmUsage(ctx, SETTLEMENT_FEATURE, ZERO_USAGE, hold.modelId, undefined, {
		plane: hold.plane,
		task: hold.task,
		budgetClass: hold.budgetClass,
		reservationId: hold.reservationId,
		rootRequestId: hold.rootRequestId,
		...(hold.parentCallId ? { parentCallId: hold.parentCallId } : {}),
		...(hold.endpoint ? { endpoint: hold.endpoint } : {}),
		policyVersion: hold.policyVersion,
		requestId: `settlement:${hold.reservationId}:${kind}`,
		settledEstimateMicrousd: microusd,
	});
}
