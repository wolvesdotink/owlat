/**
 * The `deferred` transport outcome — gate 2's numerator (plan D5, D10).
 *
 * Gate 2 is the ramp's fast signal: the own arm's deferral rate against a 10%
 * ceiling, with 25% an immediate halt (`ramp/gates.ts`), and the phase-promotion
 * rule reads the same rate across every cell. Both were reading a counter with
 * READERS AND NO WRITER — `safeRate(0)` is a perfectly good rate, so the ceiling
 * could never be reached, the halt could never fire, and the dashboard rendered
 * "0% deferrals" as a measurement rather than as a silence. A gate that cannot
 * fail is worse than no gate: it looks like evidence.
 *
 * THIS IS THE FIRST WRITER, AND IT IS DELIBERATELY NOT THE ONLY ONE THERE COULD
 * BE. What it records is the LAST-MILE ROUTER's deferral — `resolveLastMileRouting`
 * answering `defer` (a warming-cap hold, a safety-circuit pause, no usable
 * route), or a transport answering `ROUTING_DEFERRED` — which is the point where
 * a message this deployment tried to hand over provably did not go out. A remote
 * 4xx AFTER the MTA has accepted the message for delivery never comes back
 * through this path at all: the MTA retries it internally and reports it to
 * Convex only as a per-IP warming aggregate, which carries no (cell, arm). That
 * half is still uninstrumented, and `evaluateDeferralGate` is written to say so
 * rather than to read this counter's zero as a clean window — see
 * `hasDeferralTelemetry` on `RampGateEvaluationInput`.
 *
 * ONE EVENT PER SEND PER UTC DAY. A deferred send re-enters the workpool as many
 * times as the deadline and the attempt cap allow (`sendCompletion.retrySend`),
 * and a receiver that is throttling us defers every one of those attempts. Left
 * uncapped, one held message would push the numerator past the `sent`
 * denominator it is divided by and a single stuck send could halt a cell.
 * `deferralCountedDay` on the send row is the gate — the same role `openedAt`
 * plays inside `reduceOpened` and `unsubscribedAt` plays in
 * `delivery/unsubscribeOutcome.ts` — and it is a DAY rather than an instant
 * because the outcome buckets are daily: a send still being deferred tomorrow is
 * tomorrow's evidence and counts again.
 *
 * FAIL-SOFT, like every other outcome write: a send with no `sendAssignments`
 * row records nothing (the seed-probe seam, plan D18), and the effect runner
 * degrades a failed measurement write to a warning rather than rolling back the
 * retry it describes.
 */

import type { MutationCtx } from '../_generated/server';
import { resolveNow, startOfDayUtc } from '../lib/clock';
import { applyEffects, transportOutcomeEffect } from './sendLifecycle/effects';
import { withoutTestSendEffects, type SendRef } from './sendLifecycle/types';

/**
 * Where a deferral observation ended up — returned, never thrown.
 *
 * `counted` names the day the send took, which is not the claim that a counter
 * moved: a send outside the experiment has no assignment row and the effect
 * runner records nothing for it.
 */
export type RecordDeferralOutcomeResult = 'counted' | 'already_counted_today' | 'send_missing';

/**
 * Record ONE observed last-mile deferral against the send's (cell, arm) counter.
 *
 * Called INLINE from `completeSend` rather than scheduled: it is already inside
 * the mutation that decides what to do with the deferral, the per-day gate keeps
 * it to one shard write per send per day even in a retry storm, and a measurement
 * that arrived a scheduler hop later could be attributed to the wrong UTC day.
 */
export async function recordDeferralOutcome(
	ctx: MutationCtx,
	args: { readonly send: SendRef; readonly at: number }
): Promise<RecordDeferralOutcomeResult> {
	const send = await ctx.db.get(args.send.id);
	// The Send may have terminalized between the worker's answer and this
	// callback. Nothing to attribute to, and nothing to stamp.
	if (!send) return 'send_missing';

	// A NON-FINITE INSTANT IS NOT A DAY. `v.number()` is a float64 all the way
	// down, and a `NaN` here would bucket the write nowhere and defeat the gate
	// (`NaN !== NaN`, so every retry would count again). The shipped normalizer,
	// not a second rule.
	const at = resolveNow(args.at);
	const day = startOfDayUtc(at);
	if (send.deferralCountedDay === day) return 'already_counted_today';

	// Stamp BEFORE recording, exactly as the unsubscribe emitter does: the stamp
	// is the gate, and the next attempt of this send must find it set whatever
	// the recorder then decides — including "no assignment row" and the test
	// preview below, which record nothing but are still processed observations
	// for this send and day.
	await ctx.db.patch(args.send.id, { deferralCountedDay: day });
	// Through the lifecycle's own effect runner, so the outcome is written by the
	// ONE writer every other event goes through: it resolves the cell, the arm
	// and the calibration flag from the send's assignment row, and it degrades to
	// a warning rather than failing the mutation around it.
	//
	// THROUGH THE SHIPPED PREVIEW EXCLUSION, not a second copy of it. A `test`
	// send keeps the durable lifecycle — routing re-entry needs it, so it reaches
	// this callback and it carries a `sendAssignments` row — and must never become
	// telemetry. The reducers erase its effects with this function; so does the
	// one emitter that has no reducer to erase them for it.
	const { effects } = withoutTestSendEffects(send, args.send, {
		effects: [transportOutcomeEffect(args.send, 'deferred', at)],
	});
	await applyEffects(ctx, effects);
	return 'counted';
}
