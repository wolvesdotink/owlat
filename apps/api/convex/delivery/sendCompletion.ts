import { v } from 'convex/values';
import { vOnCompleteArgs } from '@convex-dev/workpool';
import { GOVERNED_MTA_MAX_MESSAGE_AGE_MS, MAX_GOVERNED_ROUTING_ATTEMPTS } from '@owlat/shared';
import { internal } from '../_generated/api';
import { internalMutation } from '../_generated/server';
import { campaignEmailPool, transactionalEmailPool } from './workpool';
import { recordDeferralOutcome } from './deferralOutcome';
import { envelopeInputValidator, retryStateValidator } from './workerEnvelope';
import type { WorkerEnvelopeInput, WorkerRetryState } from './workerEnvelope';

// ============================================================================
// Send completion (module) — see CONTEXT.md.
//
// The workpool's `onComplete` callback lands here. The module's only job is to
// translate a worker outcome into a Send lifecycle transition:
//   - success → sendLifecycle.transition({ to: 'sent', providerMessageId, … })
//   - failure → sendLifecycle.transition({ to: 'failed', errorMessage, … })
//
// All Send-state-driven side effects (campaign stats, contact activities,
// customer webhooks, attachment cleanup) live on the lifecycle's effect list
// — never imperatively here.
//
// ONE OBSERVATION HAS NO TRANSITION TO CARRY IT. A last-mile deferral leaves
// the Send `queued` — that is what makes it a deferral — so the `deferred`
// transport outcome cannot ride a lifecycle transition the way `sent` and the
// bounces do. `delivery/deferralOutcome.ts` records it from the branch below,
// still through the lifecycle's own effect runner. See that module for why the
// counter needs a writer at all.
//
// Provider health recording moved upstream to the **Send dispatch (helper)**
// per ADR-0020 — every send producer routes through that helper, so health
// is recorded uniformly (no longer skipped by test sends / automation
// emails / direct test send that bypassed this module).
//
// Symmetric to webhooks/dispatcher.ts:dispatchInboundEvent — that module
// translates external events to SendRef + transition; this one translates
// workpool results to SendRef + transition.
// ============================================================================

const sendRefValidator = v.union(
	v.object({ kind: v.literal('campaign'), id: v.id('emailSends') }),
	v.object({
		kind: v.literal('transactional'),
		id: v.id('transactionalSends'),
	})
);

// The success return shape of the `sendSingleEmail` worker action — surfaced
// on the workpool's `result.returnValue` for a successful run. (The action
// throws on failure, which the workpool reports as `result.kind === 'failed'`.)
interface SendWorkerSuccess {
	success: boolean;
	providerMessageId?: string;
	providerType?: string;
	sendLatencyMs?: number;
	// Set by the worker when a campaign recipient was found on the blocklist at
	// the pre-dispatch suppression re-check (delivery/worker.ts) — the send was
	// deliberately NOT delivered. The run itself succeeds (no retry); this flag
	// routes the Send to a suppression-labelled terminal 'failed' transition
	// instead of the generic WORKPOOL_FAILED one.
	suppressed?: boolean;
	deferred?: boolean;
	// Which side the deferral came from (`LastMileRoutingDeferred.origin`). Only
	// `governed` reaches gate 2's numerator; `local` — a policy hold, an
	// idempotency wait, an unreachable decision endpoint, an MTA answer reporting
	// any Redis failure while taking the lease — is our own machinery wherever it
	// runs, and is not evidence about this sending identity. An answer from the
	// MTA is not automatically governed; only an answer about the sending identity
	// is. Optional because a worker running older code answers without it, and an
	// unlabelled deferral is not counted rather than guessed at.
	deferralOrigin?: 'governed' | 'local';
	retryAfterMs?: number;
	envelopeInput?: WorkerEnvelopeInput;
	retryState?: WorkerRetryState;
	acceptedForDelivery?: true;
	acceptanceUnknown?: true;
	/**
	 * The ambiguity cannot be re-asked (plan D4): this transport has no
	 * idempotency surface, so the attempt is never replayed. Park the Send and
	 * let its provider feedback — or the delivery deadline — settle it. See the
	 * `awaitingProviderFeedback` arm of `GovernedDispatchResult`.
	 */
	awaitingProviderFeedback?: true;
	workAttemptId?: string;
	startedAt?: number;
}

/**
 * How long a Send may sit `queued` with its acceptance unresolved, measured
 * from the FIRST attempt — the same cumulative deadline every other governed
 * outcome is bounded by, so an ambiguous send cannot outlive a deferred one.
 */
function acceptanceDeadlineAt(startedAt: number): number {
	return startedAt + GOVERNED_MTA_MAX_MESSAGE_AGE_MS;
}

export const completeSend = internalMutation({
	args: vOnCompleteArgs(v.object({ sendRef: sendRefValidator })),
	handler: async (ctx, { result, context }) => {
		const { sendRef } = context;
		const now = Date.now();

		const returnValue =
			result.kind === 'success' ? (result.returnValue as SendWorkerSuccess | undefined) : undefined;

		// AN AMBIGUITY WITH NO SECOND QUESTION TO ASK (plan D4). Checked BEFORE the
		// MTA reconciliation below because the two are opposites: that one replays
		// the attempt (safe — its idempotency key is the MTA message id), this one
		// must never be replayed, because the lost response may sit on top of an
		// accepted and delivered message.
		//
		// So the Send is PARKED, not retried and not terminalized. It stays
		// `queued` — "we do not know yet", which is the truth and, unlike `failed`,
		// is a state a later transition can still leave. At the cumulative delivery
		// deadline it becomes `failed` with a code that names the actual condition
		// rather than `WORKPOOL_FAILED`, which reads as "the send failed".
		//
		// WHAT IS AND IS NOT REACHABLE IN THAT WINDOW, said plainly. Provider
		// feedback joins on the id the provider returned, and the lost response is
		// precisely why this row never learned one — Mandrill's `send-raw` carries
		// no caller-supplied correlator that its webhook echoes back (`metadata` is
		// a `messages/send` parameter, not a `send-raw` one), so today nothing
		// re-attaches a Mandrill `_id` to a parked row and the park exists to keep
		// the row HONEST and OPEN, not because a specific event is expected. A
		// future reconciler (a `messages/info`/`search` lookup, or a correlator
		// Mandrill agrees to echo) has a `queued` row to bind to; it would have had
		// nothing to bind to had this terminalized on the spot.
		//
		// The campaign it belongs to stays `sending` until this settles, exactly as
		// it does for any other queued send awaiting a terminal webhook — the
		// deadline is the bound (`campaigns/lifecycle.ts:tryCompleteCampaign`).
		if (returnValue?.acceptanceUnknown && returnValue.awaitingProviderFeedback) {
			const send = await ctx.db.get(sendRef.id);
			if (!send || send.status !== 'queued') return;
			// The worker's answer is an unvalidated return value, and this number
			// becomes a scheduled time: a NaN would throw at `runAt` and a
			// clock-skewed future one would park the row past the deadline it is
			// supposed to be bounded by. Normalized to "no later than now", so the
			// worst case is exactly one deadline's wait.
			const reported = returnValue.retryState?.startedAt ?? returnValue.startedAt;
			const startedAt =
				typeof reported === 'number' && Number.isFinite(reported) ? Math.min(reported, now) : now;
			const deadlineAt = acceptanceDeadlineAt(startedAt);
			if (now < deadlineAt) {
				await ctx.scheduler.runAt(
					deadlineAt,
					internal.delivery.sendCompletion.expireUnconfirmedAcceptance,
					{ sendRef, startedAt }
				);
				return;
			}
			await ctx.runMutation(internal.delivery.sendCompletion.expireUnconfirmedAcceptance, {
				sendRef,
				startedAt,
			});
			return;
		}

		if (
			returnValue?.acceptanceUnknown &&
			returnValue.providerMessageId &&
			returnValue.envelopeInput &&
			returnValue.retryState
		) {
			const send = await ctx.db.get(sendRef.id);
			if (!send || send.status !== 'queued') return;
			if (now - returnValue.retryState.startedAt < GOVERNED_MTA_MAX_MESSAGE_AGE_MS) {
				await ctx.scheduler.runAfter(
					Math.min(Math.max(returnValue.retryAfterMs ?? 1_000, 1_000), 3_600_000),
					internal.delivery.sendCompletion.retrySend,
					{
						sendRef,
						envelopeInput: returnValue.envelopeInput,
						retryState: returnValue.retryState,
					}
				);
				return;
			}
			await ctx.runMutation(internal.delivery.sendLifecycle.transitionMtaByProviderMessageId, {
				providerMessageId: returnValue.providerMessageId,
				transition: {
					to: 'failed',
					at: now,
					errorMessage: 'MTA intake acceptance could not be confirmed before the delivery deadline',
					errorCode: 'MTA_ACCEPTANCE_UNCONFIRMED',
				},
			});
			return;
		}

		// THE DEFERRAL IS THE OBSERVATION, not the retry decision that follows it.
		// Recorded before the branch below, so a deferral that has run out of
		// attempts or outlived the delivery deadline — the one that terminalizes
		// the send — reaches gate 2's numerator exactly like the ones that are
		// re-enqueued. Rate-limited to one event per send per UTC day inside the
		// recorder, and fail-soft: it never rolls back the retry.
		//
		// ONLY THE GOVERNED HALF. A `local` deferral is this deployment holding its
		// own message — a policy pause, an idempotency wait, an MTA decision endpoint
		// we could not reach, an MTA answer reporting any Redis failure while taking
		// the lease — and gate 2 halts a cell at 25%. Reaching the MTA is not what
		// makes a deferral governed; the answer being about the sending identity is.
		// Counting our own outage would take the share to the floor and revoke the
		// graduation pin over a fault the receiver never saw.
		if (returnValue?.deferred && returnValue.deferralOrigin === 'governed') {
			await recordDeferralOutcome(ctx, { send: sendRef, at: now });
		}

		if (
			returnValue?.deferred &&
			returnValue.envelopeInput &&
			returnValue.retryState &&
			returnValue.retryState.attempt <= MAX_GOVERNED_ROUTING_ATTEMPTS &&
			now - returnValue.retryState.startedAt < GOVERNED_MTA_MAX_MESSAGE_AGE_MS
		) {
			await ctx.scheduler.runAfter(
				Math.min(Math.max(returnValue.retryAfterMs ?? 60_000, 1_000), 3_600_000),
				internal.delivery.sendCompletion.retrySend,
				{
					sendRef,
					envelopeInput: returnValue.envelopeInput,
					retryState: returnValue.retryState,
				}
			);
			return;
		}

		if (returnValue?.success && returnValue.providerMessageId && returnValue.acceptedForDelivery) {
			// MTA intake is an accepted queue handoff, not remote acceptance. Keep
			// the Send queued so a later stale-route callback can still fail/retry;
			// the MTA sent webhook (or a final relay attempt) owns the terminal edge.
			const send = await ctx.db.get(sendRef.id);
			if (send?.status === 'queued') {
				if (send.providerMessageId && send.providerMessageId !== returnValue.providerMessageId) {
					throw new Error('MTA acceptance conflicts with the Send provider identity.');
				}
				await ctx.db.patch(sendRef.id, {
					providerMessageId: returnValue.providerMessageId,
					providerType: returnValue.providerType ?? 'mta',
				});
			}
			return;
		} else if (returnValue?.success && returnValue.providerMessageId) {
			await ctx.runMutation(internal.delivery.sendLifecycle.transition, {
				send: sendRef,
				transition: {
					to: 'sent',
					at: now,
					providerMessageId: returnValue.providerMessageId,
					...(returnValue.providerType ? { providerType: returnValue.providerType } : {}),
				},
			});
		} else if (returnValue?.suppressed) {
			// Recipient was on the blocklist at the worker's pre-dispatch
			// suppression re-check — the send was skipped, not delivered. Record a
			// terminal, suppression-labelled non-delivery so campaign stats and the
			// audit trail reflect that this was a deliberate honor-suppression skip
			// (not a provider failure).
			await ctx.runMutation(internal.delivery.sendLifecycle.transition, {
				send: sendRef,
				transition: {
					to: 'failed',
					at: now,
					errorMessage: 'Recipient suppressed (blocklist) before dispatch',
					errorCode: 'RECIPIENT_SUPPRESSED',
				},
			});
		} else {
			const errorMessage = result.kind === 'failed' ? result.error : 'Unknown error';
			await ctx.runMutation(internal.delivery.sendLifecycle.transition, {
				send: sendRef,
				transition: {
					to: 'failed',
					at: now,
					errorMessage: errorMessage || 'Unknown error',
					errorCode: 'WORKPOOL_FAILED',
				},
			});
		}

		// Provider health recording is intentionally NOT here — the
		// **Send dispatch (helper)** in `lib/sendProviders/dispatch.ts`
		// records every attempt uniformly upstream of this module.
	},
});

/**
 * Close a parked ambiguous-acceptance Send at the delivery deadline (plan D4).
 *
 * The ONLY thing that terminalizes a park, and it is a one-way door with two
 * guards. A Send that is no longer `queued` has already been settled by
 * something with better evidence — a provider webhook, a purge, an operator —
 * and is left alone. A run that fires EARLY (a rescheduled callback, a clock
 * that moved) is not the deadline it was armed for and does nothing: the park
 * outlives a stray wake-up rather than terminalizing a message whose acceptance
 * question is still open.
 *
 * The error code is deliberately its own: `WORKPOOL_FAILED` would report a
 * definite send failure for a message the provider may well have delivered, and
 * that is the claim this whole posture exists to stop making.
 */
export const expireUnconfirmedAcceptance = internalMutation({
	args: { sendRef: sendRefValidator, startedAt: v.number() },
	handler: async (ctx, args) => {
		const send = await ctx.db.get(args.sendRef.id);
		if (!send || send.status !== 'queued') return;
		const now = Date.now();
		// A degenerate instant is not a deadline. `completeSend` normalizes the one
		// it schedules with, so this can only be a hand-made call; leaving the park
		// in place is the conservative answer, and the next legitimate arming of
		// this mutation still closes the row.
		if (!Number.isFinite(args.startedAt)) return;
		if (now < acceptanceDeadlineAt(args.startedAt)) return;
		await ctx.runMutation(internal.delivery.sendLifecycle.transition, {
			send: args.sendRef,
			transition: {
				to: 'failed',
				at: now,
				errorMessage:
					'Provider acceptance could not be confirmed before the delivery deadline; the message may or may not have been delivered',
				errorCode: 'PROVIDER_ACCEPTANCE_UNCONFIRMED',
			},
		});
	},
});

/** Re-enter the same bounded workpool after a typed last-mile deferral. */
export const retrySend = internalMutation({
	args: {
		sendRef: sendRefValidator,
		envelopeInput: envelopeInputValidator,
		retryState: retryStateValidator,
	},
	handler: async (ctx, args) => {
		// The Send may have terminalized between arming this retry and running it
		// — a routing re-entry successor landed, or a webhook resolved it. Its
		// worker would then throw on the missing queued Send, and the workpool
		// failure would demote an already-`sent` row to `failed`, deleting its
		// attachments and closing the row to the real bounce that follows.
		const send = await ctx.db.get(args.sendRef.id);
		if (!send || send.status !== 'queued') return;
		const pool = args.sendRef.kind === 'campaign' ? campaignEmailPool : transactionalEmailPool;
		await pool.enqueueAction(
			ctx,
			internal.delivery.worker.sendSingleEmail,
			{ envelopeInput: args.envelopeInput, retryState: args.retryState },
			{
				onComplete: internal.delivery.sendCompletion.completeSend,
				context: { sendRef: args.sendRef },
			}
		);
	},
});
