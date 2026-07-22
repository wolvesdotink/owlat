import { v } from 'convex/values';
import { vOnCompleteArgs } from '@convex-dev/workpool';
import { internal } from '../_generated/api';
import { internalMutation } from '../_generated/server';
import { mirrorEmailSendWrite } from '../unifiedMessages';
import { campaignEmailPool, transactionalEmailPool } from './workpool';

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

const retryStateValidator = v.object({
	attempt: v.number(),
	startedAt: v.number(),
	idempotencyKey: v.string(),
});

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
	envelopeInput?: unknown;
	retryState?: { attempt: number; startedAt: number; idempotencyKey: string };
}

const MAX_ROUTING_RETRIES = 8;
const MAX_ROUTING_RETRY_AGE_MS = 6 * 60 * 60 * 1000;

export const completeSend = internalMutation({
	args: vOnCompleteArgs(v.object({ sendRef: sendRefValidator })),
	handler: async (ctx, { result, context }) => {
		const { sendRef } = context;
		const now = Date.now();

		const returnValue =
			result.kind === 'success' ? (result.returnValue as SendWorkerSuccess | undefined) : undefined;

		const succeeded = Boolean(returnValue?.success && returnValue.providerMessageId);
		if (
			returnValue?.deferred &&
			returnValue.envelopeInput &&
			returnValue.retryState &&
			returnValue.retryState.attempt <= MAX_ROUTING_RETRIES &&
			now - returnValue.retryState.startedAt <= MAX_ROUTING_RETRY_AGE_MS
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

		if (returnValue?.success && returnValue.providerMessageId) {
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

		// Agent-reply reconciliation: an `agent_reply` Send carries the inbound
		// message it answers. `sendApprovedReply` no longer marks that message
		// `sent` optimistically at dispatch (ADR-0010) — it enqueues and lets the
		// confirmed worker outcome drive the inbound message's terminal state
		// here, symmetric to the campaign reconcile above. Without this, an agent
		// reply would send but leave its inbound message stuck in `approved`.
		if (sendRef.kind === 'transactional') {
			const send = await ctx.db.get(sendRef.id);
			if (send?.kind === 'agent_reply' && send.inboundMessageId) {
				await ctx.runMutation(internal.inbox.processingLifecycle.transition, {
					inboundMessageId: send.inboundMessageId,
					input: succeeded
						? { to: 'sent', at: now }
						: {
								to: 'failed',
								at: now,
								errorMessage:
									result.kind === 'failed' ? result.error || 'Send failed' : 'Send failed',
							},
				});

				// Mirror the CONFIRMED agent reply into the unified contact timeline,
				// the outbound counterpart to the inbound mirror in
				// inbox/messages.ts. An agent reply lives on a real conversationThread,
				// so it's a genuine conversation turn — unlike campaign / transactional
				// / automation sends, which are NOT mirrored (no inbound thread; they
				// surface in the Activity tab via contactActivities). Idempotent on the
				// provider message id and best-effort: a mirror failure must not undo
				// the lifecycle transitions above or fail the workpool callback.
				if (succeeded) {
					try {
						const inbound = await ctx.db.get(send.inboundMessageId);
						if (inbound?.threadId && send.contactId) {
							await mirrorEmailSendWrite(ctx, {
								threadId: inbound.threadId,
								contactId: send.contactId,
								subject: send.subject,
								textBody: inbound.draftResponse,
								externalMessageId: returnValue?.providerMessageId,
								status: 'sent',
							});
						}
					} catch {
						// Best-effort: the timeline mirror is a denormalized read model,
						// never the source of truth. Swallow so a mirror error can't fail
						// the Send completion callback (which would re-run the lifecycle
						// transitions). The next confirmed reply re-establishes the thread.
					}
				}
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
		envelopeInput: v.any(),
		retryState: v.object({
			attempt: v.number(),
			startedAt: v.number(),
			idempotencyKey: v.string(),
		}),
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

/**
 * Re-enter governed dispatch after the MTA accepted a job but detected a stale
 * route before opening an SMTP connection. The attempt marker and workpool
 * enqueue commit atomically, making retried HMAC webhooks idempotent while the
 * original Send and provider idempotency key remain unchanged.
 */
export const reenterAcceptedMtaSend = internalMutation({
	args: {
		sendRef: sendRefValidator,
		messageId: v.string(),
		envelopeInput: v.any(),
		retryState: retryStateValidator,
		reason: v.string(),
	},
	handler: async (ctx, args) => {
		const send =
			args.sendRef.kind === 'campaign'
				? await ctx.db.get(args.sendRef.id)
				: await ctx.db.get(args.sendRef.id);
		if (!send) return { disposition: 'send_not_found' as const };
		if (send.status !== 'queued' && send.status !== 'sent') {
			return { disposition: 'terminal' as const };
		}
		if (send.providerMessageId && send.providerMessageId !== args.messageId) {
			return { disposition: 'message_mismatch' as const };
		}
		if (
			(send.mtaRoutingReentryAttempt ?? 0) >= args.retryState.attempt ||
			args.retryState.attempt > MAX_ROUTING_RETRIES ||
			Date.now() - args.retryState.startedAt > MAX_ROUTING_RETRY_AGE_MS
		) {
			return { disposition: 'duplicate_or_expired' as const };
		}

		await ctx.db.patch(args.sendRef.id, {
			mtaRoutingReentryAttempt: args.retryState.attempt,
		});
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
		return { disposition: 'enqueued' as const, reason: args.reason };
	},
});
