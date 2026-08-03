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
 * BE. What it records is the GOVERNED half of the LAST-MILE ROUTER's deferrals —
 * `resolveLastMileRouting` answering `defer` with `origin: 'governed'` (the MTA
 * declining THIS IDENTITY: an open safety circuit, no warmed IP, an open breaker
 * with no relay to catch the overflow), or a transport answering
 * `ROUTING_DEFERRED` — which is the point where a message this deployment tried
 * to hand over provably did not go out for a reason about the sending identity.
 * An answer FROM the MTA is not enough on its own; it has to be an answer ABOUT
 * the identity, which is why the adapter classifies per defer reason
 * (`lib/sendProviders/mta/index.ts`, `MTA_DEFER_REASON_ORIGIN`).
 *
 * ONLY THE FIRST OF THOSE TWO SOURCES ENFORCES THAT RULE TODAY. The
 * `ROUTING_DEFERRED` branch in `governedDispatch.ts` hardcodes
 * `deferralOrigin: 'governed'` for every transport defer, and the adapter routes
 * any 409 carrying a `ROUTING_DECISION_` code into it — including
 * `ROUTING_DECISION_EXPIRED`, which the MTA also answers when `readRoutingLease`
 * comes back empty because its Redis lost the key rather than because the lease
 * aged out. A store failure on our own side can therefore still spend gate 2's
 * budget through that path. Classifying it needs the MTA to tell an expired
 * lease apart from an unreadable one on the wire, which is parked for the
 * aggregate; until it lands, read the rule above as holding for
 * `resolveLastMileRouting`'s own answer and as an intention for the other.
 *
 * WHAT IT DOES NOT RECORD, and this is not an omission: `origin: 'local'`. A
 * deliberate policy hold, the idempotency reconciliation wait, an unconfigured or
 * unreachable MTA decision endpoint, a warm-up cap we set ourselves, and the MTA
 * reporting any Redis failure while taking the lease — those are this deployment
 * holding its own message, wherever the machinery that held it runs. Gate 2 halts
 * a cell at 25%, so counting a forty-minute outage on our own side would drop the
 * share to the floor, open a cooldown and revoke a graduation pin over a fault no
 * receiver ever saw. `completeSend` does the filtering, because the origin travels
 * on the worker's answer and dies there.
 *
 * A remote 4xx AFTER the MTA has accepted the message for delivery never comes
 * back through this path at all: the MTA retries it internally and reports it to
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
 * `observed` is the word on purpose: it names the day the send took, and makes
 * no claim that a counter moved. A send outside the experiment has no assignment
 * row and the effect runner records nothing for it, which is still an
 * observation this send and day have been processed.
 */
export type RecordDeferralOutcomeResult =
	| 'observed'
	| 'already_observed_today'
	| 'send_missing'
	| 'send_not_queued';

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
	// The row is gone — deleted, or a purge ran between the worker's answer and
	// this callback. Nothing to attribute to, and nothing to stamp.
	if (!send) return 'send_missing';
	// A DEFERRAL IS A THING THAT HAPPENS TO A QUEUED SEND. Between the worker
	// answering and this callback running, a concurrent MTA acceptance may have
	// moved the send to `sent` and a stale route callback may have failed it — and
	// a send counted in the `sent` denominator must not also be counted in the
	// numerator divided by it. `completeSend` guards its own reconciliation branch
	// against the same race, in the same words.
	if (send.status !== 'queued') return 'send_not_queued';

	// A NON-FINITE INSTANT IS NOT A DAY. The instant comes from `completeSend`'s
	// own `Date.now()` in-process, so this is a belt rather than a boundary check
	// — but a `NaN` reaching `startOfDayUtc` would bucket the write nowhere and
	// defeat the per-day gate (`NaN !== NaN`, so every retry would count again),
	// and every other outcome writer normalizes through the same helper.
	const at = resolveNow(args.at);
	const day = startOfDayUtc(at);
	if (send.deferralCountedDay === day) return 'already_observed_today';

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
	return 'observed';
}
