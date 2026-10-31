import { type Infer, v } from 'convex/values';
import { vOnCompleteArgs } from '@convex-dev/workpool';
import { governedDeliveryDeadlineAt } from '@owlat/shared';
import { internal } from '../_generated/api';
import type { MutationCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { logError } from '../lib/runtimeLog';
import { InternalFailure } from '../_utils/errors';
import { enqueueGovernedSend } from './governedEnqueue';
import { recordDeferralOutcome } from './deferralOutcome';
import { envelopeInputValidator, retryStateValidator } from './workerEnvelope';
import { countableSendRefValidator } from '../lib/validators/send';
import { recordCompletionFailure } from './sendCompletionFailures';
import {
	completionReadsSend,
	planCompletionOutcome,
	readCompletion,
} from './sendCompletionDecision';

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
// — every send producer routes through that helper, so health
// is recorded uniformly (no longer skipped by test sends / automation
// emails / direct test send that bypassed this module).
//
// Symmetric to webhooks/dispatcher.ts:dispatchInboundEvent — that module
// translates external events to SendRef + transition; this one translates
// workpool results to SendRef + transition.
// ============================================================================

const sendRefValidator = countableSendRefValidator;

/** The countable Send this callback is bound to (a probe never gets one). */
type SendCompletionRef = Infer<typeof sendRefValidator>;

const completionArgs = vOnCompleteArgs(v.object({ sendRef: sendRefValidator }));

/**
 * The workpool's `onComplete` for every governed send.
 *
 * A SHELL THAT CANNOT LOSE THE RESULT. The workpool keeps no record of
 * an `onComplete` that throws: it retries once, logs, and deletes the work, and
 * with it the only copy of a direct provider's message id. So the completion
 * runs as a nested mutation, whose writes roll back on their own when it
 * throws, and a throw is caught here and recorded instead: the provider
 * identity goes onto the still-queued Send and the outcome into
 * `sendCompletionFailures`, both in this outer transaction, which commits.
 * `delivery/sendCompletionFailures.ts` replays the record.
 */
export const completeSend = internalMutation({
	args: completionArgs,
	handler: async (ctx, args) => {
		try {
			await ctx.runMutation(internal.delivery.sendCompletion.applyCompletion, args);
		} catch (error) {
			await recordCompletionFailure(ctx, args, error);
		}
	},
});

/**
 * Translate one worker outcome into the Send's lifecycle. Called by
 * `completeSend` and by a completion-failure replay, never by the workpool.
 *
 * `isEnvelopeStripped` comes from a replay: a recorded outcome keeps no
 * envelope (`./sendCompletionPayload`), because the record only replays the
 * terminal branch. A re-entry it would still take refuses rather than send a
 * stub.
 *
 * The deciding is `./sendCompletionDecision`; this shell loads the Send when
 * the arm needs it and runs the one step the plan names.
 */
export const applyCompletion = internalMutation({
	args: { ...completionArgs.fields, isEnvelopeStripped: v.optional(v.boolean()) },
	handler: async (ctx, { workId, result, context, isEnvelopeStripped }) => {
		const { sendRef } = context;
		const now = Date.now();
		const reading = readCompletion(result);
		if (reading.kind === 'decided' && reading.unreadableShape !== undefined) {
			logError('[SendCompletion] Unreadable worker result', {
				workId,
				sendKind: sendRef.kind,
				sendId: sendRef.id,
				shape: reading.unreadableShape,
			});
		}
		const plan =
			reading.kind === 'decided'
				? reading.plan
				: planCompletionOutcome({
						outcome: reading.outcome,
						send: completionReadsSend(reading.outcome) ? await ctx.db.get(sendRef.id) : null,
						now,
						isEnvelopeStripped: isEnvelopeStripped === true,
					});
		if (plan.recordsDeferral) await recordDeferralOutcome(ctx, { send: sendRef, at: now });

		const { step } = plan;
		switch (step.kind) {
			case 'none':
				return;
			case 'refuse':
				throw new InternalFailure(step.failure, { retryable: false });
			case 'fail':
				await failSend(ctx, sendRef, now, step.errorMessage, step.errorCode);
				return;
			case 'failByProviderMessageId':
				await ctx.runMutation(internal.delivery.sendLifecycle.transitionMtaByProviderMessageId, {
					isCompletionCall: true,
					providerMessageId: step.providerMessageId,
					transition: {
						to: 'failed',
						at: now,
						errorMessage: step.errorMessage,
						errorCode: step.errorCode,
					},
				});
				return;
			case 'scheduleExpiry':
				await ctx.scheduler.runAt(
					step.runAt,
					internal.delivery.sendCompletion.expireUnconfirmedAcceptance,
					{ sendRef, startedAt: step.startedAt }
				);
				return;
			case 'expireNow':
				await ctx.runMutation(internal.delivery.sendCompletion.expireUnconfirmedAcceptance, {
					sendRef,
					startedAt: step.startedAt,
				});
				return;
			case 'scheduleRetry':
				await ctx.scheduler.runAfter(step.delayMs, internal.delivery.sendCompletion.retrySend, {
					sendRef,
					envelopeInput: step.envelopeInput,
					retryState: step.retryState,
				});
				return;
			case 'recordCustody':
				await ctx.db.patch(sendRef.id, {
					providerMessageId: step.providerMessageId,
					providerType: step.providerType,
				});
				return;
			case 'markSent':
				await ctx.runMutation(internal.delivery.sendLifecycle.transition, {
					send: sendRef,
					transition: {
						to: 'sent',
						at: now,
						providerMessageId: step.providerMessageId,
						providerType: step.providerType,
					},
				});
				return;
		}

		// Provider health recording is intentionally NOT here — the
		// **Send dispatch (helper)** in `lib/sendProviders/dispatch.ts`
		// records every attempt uniformly upstream of this module.
	},
});

/** The single terminal-failure write, so every arm names its own code. */
async function failSend(
	ctx: MutationCtx,
	sendRef: SendCompletionRef,
	at: number,
	errorMessage: string,
	errorCode: string
): Promise<void> {
	await ctx.runMutation(internal.delivery.sendLifecycle.transition, {
		send: sendRef,
		transition: { to: 'failed', at, errorMessage, errorCode },
	});
}

/**
 * Close a parked ambiguous-acceptance Send at the delivery deadline.
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
		if (now < governedDeliveryDeadlineAt(args.startedAt)) return;
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
		await enqueueGovernedSend(ctx, args.sendRef, {
			envelopeInput: args.envelopeInput,
			retryState: args.retryState,
		});
	},
});
