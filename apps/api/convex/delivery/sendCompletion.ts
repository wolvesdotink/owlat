import { v } from 'convex/values';
import { vOnCompleteArgs } from '@convex-dev/workpool';
import { GOVERNED_MTA_MAX_MESSAGE_AGE_MS, MAX_GOVERNED_ROUTING_ATTEMPTS } from '@owlat/shared';
import { internal } from '../_generated/api';
import { internalMutation } from '../_generated/server';
import { campaignEmailPool, transactionalEmailPool } from './workpool';
import { envelopeInputValidator, retryStateValidator } from './workerEnvelope';
import type { WorkerEnvelopeInput } from './workerEnvelope';

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
	retryAfterMs?: number;
	envelopeInput?: WorkerEnvelopeInput;
	retryState?: { attempt: number; startedAt: number; idempotencyKey: string };
	acceptedForDelivery?: true;
}

export const completeSend = internalMutation({
	args: vOnCompleteArgs(v.object({ sendRef: sendRefValidator })),
	handler: async (ctx, { result, context }) => {
		const { sendRef } = context;
		const now = Date.now();

		const returnValue =
			result.kind === 'success' ? (result.returnValue as SendWorkerSuccess | undefined) : undefined;

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

		// Batch completion: a campaign Send just left the queue. Reconcile the
		// owning campaign — when its LAST queued send clears, this advances the
		// campaign 'sending' → 'sent' (the step the pipeline previously lacked,
		// which left every campaign stuck in 'sending' forever). No-op until the
		// last send completes; transactional sends have no campaign to advance.
		if (sendRef.kind === 'campaign') {
			const send = await ctx.db.get(sendRef.id);
			if (send) {
				await ctx.runMutation(internal.campaigns.lifecycle.reconcileCampaignCompletion, {
					campaignId: send.campaignId,
				});
			}
		}

		// Provider health recording is intentionally NOT here — the
		// **Send dispatch (helper)** in `lib/sendProviders/dispatch.ts`
		// records every attempt uniformly upstream of this module.
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
