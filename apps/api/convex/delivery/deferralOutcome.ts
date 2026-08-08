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
 * BOTH SOURCES ENFORCE THAT RULE, on either side of one distinction the MTA now
 * makes on the wire (issue #505). The adapter routes a 409 carrying a
 * `ROUTING_DECISION_` code into a `governed` transport defer — an aged-out or
 * no-longer-binding lease, a breaker or IP generation that moved, all of them
 * the MTA declining THIS IDENTITY — while a lease it could not READ answers
 * `ROUTING_LEASE_UNREADABLE` instead (`routes/sendRoutingLease.ts`), which the
 * `ROUTING_DEFERRED` branch in `governedDispatch.ts` marks `local` beside the
 * `lease_persistence` case. A truncated or corrupt lease record is our own
 * storage failing and no longer spends gate 2's budget. ONE HONEST RESIDUE: a
 * lease key that is simply GONE reads as absent, and a Redis `GET` cannot tell a
 * key that aged out of its 15-minute TTL from one an eviction or an empty-replica
 * failover took — the MTA keeps calling that `governed`, because the ordinary
 * cause is the TTL and the alternative is guessing.
 *
 * WHAT IT DOES NOT RECORD, and this is not an omission: `origin: 'local'`. A
 * deliberate policy hold, the idempotency reconciliation wait, an unconfigured or
 * unreachable MTA decision endpoint, a warm-up cap we set ourselves, and the MTA
 * reporting any Redis failure while taking the lease or an unreadable record
 * when it reads that lease back at enqueue — those are this deployment
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
 * row records nothing (the seed-probe seam, plan D18), and the counter bump
 * itself is scheduled off this mutation by the effect runner into
 * `analytics.transportOutcomes.recordOutcomeForSend`, which degrades its own
 * failure to a warning rather than rolling back the retry it describes.
 */

import { v } from 'convex/values';
import { internalMutation, type MutationCtx } from '../_generated/server';
import { resolveNow, startOfDayUtc } from '../lib/clock';
import { applyEffects, transportOutcomeEffect } from './sendLifecycle/effects';
import { resolveProviderMessageId } from './sendLifecycle/lookups';
import {
	withoutTestSendEffects,
	type EmailSendDoc,
	type SendRef,
	type TransactionalSendDoc,
} from './sendLifecycle/types';

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
 * Called INLINE from `completeSend`: the observation belongs in the mutation that
 * owns the deferral decision, because that mutation also owns the per-day stamp
 * this function writes — read, decided and stamped in one transaction, so a retry
 * storm cannot race two callbacks into taking the same day twice.
 *
 * The counter bump it emits is a separate question, and the effect runner answers
 * it the other way: `transport_outcome` is scheduled, so the shard write lands
 * outside this transaction. Day attribution survives that hop because `at` rides
 * on the effect and `recordTransportOutcomeForSend` buckets on the instant it is
 * given rather than on its own clock.
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

	return await stampAndRecordDeferralDay(ctx, send, args.send, args.at);
}

/**
 * The per-day stamp and the counter bump — the half both deferral sources share.
 *
 * Extracted rather than copied because the two sources differ ONLY in which
 * send states are legitimate (see `recordRelayDeferral` below); the day gate,
 * the preview exclusion and the effect runner they go through must stay one
 * piece of code, or the two counters they feed stop meaning the same thing.
 */
async function stampAndRecordDeferralDay(
	ctx: MutationCtx,
	send: EmailSendDoc | TransactionalSendDoc,
	ref: SendRef,
	rawAt: number
): Promise<'observed' | 'already_observed_today'> {
	// A NON-FINITE INSTANT IS NOT A DAY. The instant comes from `completeSend`'s
	// own `Date.now()` in-process, so this is a belt rather than a boundary check
	// — but a `NaN` reaching `startOfDayUtc` would bucket the write nowhere and
	// defeat the per-day gate (`NaN !== NaN`, so every retry would count again),
	// and every other outcome writer normalizes through the same helper.
	const at = resolveNow(rawAt);
	const day = startOfDayUtc(at);
	if (send.deferralCountedDay === day) return 'already_observed_today';

	// Stamp BEFORE recording, exactly as the unsubscribe emitter does: the stamp
	// is the gate, and the next attempt of this send must find it set whatever
	// the recorder then decides — including "no assignment row" and the test
	// preview below, which record nothing but are still processed observations
	// for this send and day.
	await ctx.db.patch(ref.id, { deferralCountedDay: day });
	// Through the lifecycle's own effect runner, so the outcome is written by the
	// ONE writer every other event goes through: it resolves the cell, the arm
	// and the calibration flag from the send's assignment row, and — scheduled off
	// this transaction like every other `transport_outcome` — it swallows its own
	// failure rather than failing the mutation around it.
	//
	// THROUGH THE SHIPPED PREVIEW EXCLUSION, not a second copy of it. A `test`
	// send keeps the durable lifecycle — routing re-entry needs it, so it reaches
	// this callback and it carries a `sendAssignments` row — and must never become
	// telemetry. The reducers erase its effects with this function; so does the
	// one emitter that has no reducer to erase them for it.
	const { effects } = withoutTestSendEffects(send, ref, {
		effects: [transportOutcomeEffect(ref, 'deferred', at)],
	});
	await applyEffects(ctx, effects);
	return 'observed';
}

/** Where a RELAY-reported deferral ended up — returned, never thrown. */
export type RecordRelayDeferralResult = RecordDeferralOutcomeResult | 'send_not_found';

/**
 * THE SECOND WRITER the module docstring said there could be: a deferral a
 * RELAY reports back over its webhook (Mandrill `deferral`, plan D10).
 *
 * The docstring above names this half explicitly and says it is uninstrumented:
 * "A remote 4xx AFTER the MTA has accepted the message for delivery never comes
 * back through this path at all." For the reference arm it does come back — the
 * relay is the one holding the message and it tells us so — and D10 puts it in
 * `transportOutcomes.deferred` for that arm, which is what this mutation does.
 *
 * WHY THE `queued` GUARD IS ABSENT, and this is the whole difference between the
 * two writers. The governed writer refuses a non-`queued` send because a send
 * that has reached the `sent` DENOMINATOR must not also enter the NUMERATOR
 * divided by it: for our own MTA, `sent` means a receiver accepted the message,
 * so a deferral afterwards is a contradiction. A relay's `sent` means the RELAY's
 * API accepted it, and every deferral it will ever report necessarily happens
 * after that instant. Keeping the guard here would leave the reference arm's
 * gate-2 numerator with readers and no writer — the exact fault the governed
 * writer was added to fix.
 *
 * WHAT THAT LEAVES OPEN, said plainly rather than buried: the two arms now write
 * this counter from different points on the delivery path — ours before remote
 * acceptance, the relay's after it — so gate 2 compares two arms on rulers that
 * are not yet proven identical. P2.3 (ramp-signal verification) owns that
 * question; `hasDeferralTelemetry` on `RampGateEvaluationInput` is where a
 * decision to distrust the comparison would land.
 *
 * FAIL-SOFT like its sibling: an unknown provider message id (a send purged, or
 * an event for a message this deployment never sent) records nothing and says so
 * — a webhook must never 5xx on an id it cannot resolve.
 */
export const recordRelayDeferral = internalMutation({
	args: { providerMessageId: v.string(), at: v.number() },
	handler: async (ctx, args): Promise<RecordRelayDeferralResult> => {
		const ref = await resolveProviderMessageId(ctx, args.providerMessageId);
		if (!ref) return 'send_not_found';
		const send = await ctx.db.get(ref.id);
		if (!send) return 'send_missing';
		return await stampAndRecordDeferralDay(ctx, send, ref, args.at);
	},
});
