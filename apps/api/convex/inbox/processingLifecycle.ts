/**
 * Inbox processing lifecycle (module) — single writer of
 * `inboundMessages.processingStatus`, the matching `agentActions` rows, and
 * `conversationThreads.latestDraftStatus`. Owns the 12-state graph and the
 * companion-field atomicity (securityFlags, classification, draftResponse,
 * etc.) so a crash between the status patch and the per-step writes can no
 * longer leave the row in an inconsistent state.
 *
 * This file is the dispatcher + public-function surface. The state graph and
 * pure per-state reducers live in `./processingLifecycle/reducers.ts`; the
 * effect runner + legal-edge dispatcher live in
 * `./processingLifecycle/effects.ts`. Splitting the side-effect-free reducers
 * from the IO runner mirrors the sibling lifecycles
 * (delivery/sendLifecycle.ts, mail/draftLifecycle.ts) and keeps each file
 * under the size cap. The generated function paths
 * (`internal.inbox.processingLifecycle.*`) are unchanged — every public
 * mutation still lives here.
 *
 * Public surface:
 *   - transition({inboundMessageId, input})   — status changes (legal-edge checked).
 *                                              Optionally creates / completes
 *                                              the matching agentAction in the
 *                                              same mutation.
 *   - recordStepBegin / recordStepEnd / recordStepFail — agentAction writes
 *                                              for steps that do NOT change
 *                                              `processingStatus` (today's
 *                                              `context_retrieval`, `route` —
 *                                              the status changes happen at
 *                                              neighbouring step boundaries).
 *
 * See docs/adr/0010-inbox-processing-lifecycle-module.md and
 * docs/adr/0014-agent-step-module.md.
 */

import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import {
	contextCoverageValidator,
	draftQualityValidator,
	isOutboundChannel,
	tokenUsageValidator,
} from '../lib/convexValidators';
import {
	actionTypeValidator,
	transitionInputValidator,
	type TransitionOutcome,
} from './processingLifecycle/types';
import { dispatch } from './processingLifecycle/effects';

// Re-export the lifecycle types so existing cross-file importers
// (`agent/steps/*`, tests) keep a single import surface.
export type {
	ProcessingStatus,
	ActionType,
	ActionStatus,
	TransitionInput,
	TransitionOutcome,
} from './processingLifecycle/types';

// ─── Public mutations ───────────────────────────────────────────────────────

/**
 * Apply a processing-status transition to an inbound message. The only
 * writer of `inboundMessages.processingStatus` and of the companion fields
 * patched alongside it (securityFlags, classification, draftResponse,
 * errorMessage, contextTier). Also the only writer of
 * `conversationThreads.latestDraftStatus` for messages that have a thread.
 *
 * Optionally completes a running agentAction in the same mutation
 * (`completedActionId`) and / or fails one on `to: 'failed'`
 * (`failingActionId`). Atomic with the status patch.
 */
export const transition = internalMutation({
	args: {
		inboundMessageId: v.id('inboundMessages'),
		input: transitionInputValidator,
	},
	handler: async (ctx, args): Promise<TransitionOutcome> => {
		const message = await ctx.db.get(args.inboundMessageId);
		if (!message) return { ok: false, reason: 'message_not_found' };
		return await dispatch(ctx, message, args.input);
	},
});

// ─── Agent-action mutations (used inside a single processingStatus) ─────────
//
// `recordStepBegin` / `recordStepEnd` / `recordStepFail` own writes to the
// `agentActions` table. They sit beside `transition` rather than inside it
// because today's pipeline runs MULTIPLE steps inside one processingStatus
// state (context_retrieval + classify both run while processingStatus is
// 'classifying'; plan + draft both run while 'drafting'). Splitting them
// out means each step still atomically marks its own agentAction row,
// without the lifecycle's `transition` having to know which step is in
// flight.

export const recordStepBegin = internalMutation({
	args: {
		inboundMessageId: v.id('inboundMessages'),
		actionType: actionTypeValidator,
	},
	handler: async (ctx, args): Promise<{ actionId: Id<'agentActions'> }> => {
		const actionId = await ctx.db.insert('agentActions', {
			inboundMessageId: args.inboundMessageId,
			actionType: args.actionType,
			status: 'running',
			retryCount: 0,
			startedAt: Date.now(),
			createdAt: Date.now(),
		});
		return { actionId };
	},
});

export const recordStepEnd = internalMutation({
	args: {
		actionId: v.id('agentActions'),
		output: v.optional(v.string()),
		durationMs: v.optional(v.number()),
		modelUsed: v.optional(v.string()),
		tokenUsage: v.optional(tokenUsageValidator),
	},
	handler: async (ctx, args) => {
		// Defense-in-depth: a vanished action row (deleted by a concurrent
		// cleanup, or an id from a stale closure after a retry) must not crash
		// the step — patch on a missing id throws. The sibling writers
		// (recordStepFail, the `complete_action` effect) already guard; this
		// one used to assume the row was present.
		const action = await ctx.db.get(args.actionId);
		if (!action) return;
		await ctx.db.patch(args.actionId, {
			status: 'completed',
			output: args.output,
			completedAt: Date.now(),
			durationMs: args.durationMs,
			modelUsed: args.modelUsed,
			tokenUsage: args.tokenUsage,
		});
	},
});

export const recordStepFail = internalMutation({
	args: {
		actionId: v.id('agentActions'),
		errorMessage: v.string(),
	},
	handler: async (ctx, args) => {
		const action = await ctx.db.get(args.actionId);
		if (!action) return;
		await ctx.db.patch(args.actionId, {
			status: 'failed',
			errorMessage: args.errorMessage,
			completedAt: Date.now(),
			retryCount: action.retryCount + 1,
		});
	},
});

/**
 * Record the context-tier metadata onto an inboundMessage without
 * changing its processingStatus. Used by the `context_retrieval`
 * Agent step (module) after its execute completes (still in
 * `classifying` state).
 *
 * Also persists the ADVISORY retrieval-coverage / grounding signal
 * (which briefing legs were populated, knowledge-hit count, top score,
 * derived low-coverage). Coverage is optional so callers that only have
 * a tier still work; it changes NO routing today.
 */
export const recordContextTier = internalMutation({
	args: {
		inboundMessageId: v.id('inboundMessages'),
		contextTier: v.union(
			v.literal('normal'),
			v.literal('compacted'),
			v.literal('emergency'),
		),
		contextCoverage: v.optional(contextCoverageValidator),
	},
	handler: async (ctx, args) => {
		await ctx.db.patch(args.inboundMessageId, {
			contextTier: args.contextTier,
			...(args.contextCoverage
				? { contextCoverage: args.contextCoverage }
				: {}),
		});
	},
});

/**
 * Record the agent's generated draft onto an inboundMessage without
 * changing its processingStatus. Used by the `draft` Agent step
 * (module) after its execute completes (still in `drafting` state).
 * The next step (`route`) reads the stored fields to make its routing
 * decision.
 */
export const recordDraftOutput = internalMutation({
	args: {
		inboundMessageId: v.id('inboundMessages'),
		draftResponse: v.string(),
		draftSubject: v.string(),
		confidenceScore: v.number(),
		// Draft-quality self-check result — persisted SEPARATELY from the
		// classifier confidenceScore. Optional: absent when the self-check
		// LLM call failed (the route step then treats quality as unknown/LOW).
		draftQuality: v.optional(draftQualityValidator),
	},
	handler: async (ctx, args) => {
		await ctx.db.patch(args.inboundMessageId, {
			draftResponse: args.draftResponse,
			draftSubject: args.draftSubject,
			confidenceScore: args.confidenceScore,
			...(args.draftQuality ? { draftQuality: args.draftQuality } : {}),
		});
	},
});

// ─── Cron-driven retry ──────────────────────────────────────────────────────
//
// Replaces `agent/agentPipeline.retryFailedActions`. Resets failed
// agentActions whose `retryCount < maxRetries` and brings their
// inboundMessages back to 'received' atomically via the lifecycle.

export const retryFailedActions = internalMutation({
	args: {},
	handler: async (ctx) => {
		const failedActions = await ctx.db
			.query('agentActions')
			.withIndex('by_status', (q) => q.eq('status', 'failed'))
			.take(20);

		const maxRetries = 3;
		const now = Date.now();

		for (const action of failedActions) {
			if (action.retryCount >= maxRetries) continue;
			const message = await ctx.db.get(action.inboundMessageId);
			if (!message || message.processingStatus !== 'failed') continue;

			await dispatch(ctx, message, {
				to: 'received',
				at: now,
				source: 'cron_retry',
				resetActionId: action._id,
			});
		}
	},
});

// ─── Lost-send-completion reconcile ──────────────────────────────────────────
//
// An approved message's only legal next state is `sent`, driven solely by the
// Send completion module's `onComplete` callback (delivery/sendCompletion.ts).
// If that callback is ever lost — workpool drops it, a deploy lands mid-flight,
// the worker is killed after enqueue — the message wedges in `approved` forever:
// `retryFailedActions` only handles `failed`, and there is no other path out of
// `approved`. This cron finds messages stuck in `approved` past a staleness
// threshold with NO live `queued` agent_reply send still in flight and
// re-enqueues the reply (the same effect the `approved` transition fires), so a
// dropped completion self-heals on the next tick.

const APPROVED_STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes overdue

export const reconcileStuckApproved = internalMutation({
	args: {},
	handler: async (ctx): Promise<{ reEnqueued: number }> => {
		const cutoff = Date.now() - APPROVED_STALE_THRESHOLD_MS;

		const approved = await ctx.db
			.query('inboundMessages')
			.withIndex('by_processing_status', (q) => q.eq('processingStatus', 'approved'))
			.take(100);

		// Only the ones that have been sitting in `approved` long enough that a
		// healthy send would already have completed. `processedAt` is stamped when
		// the message enters `approved` (the reducer sets it on that edge).
		//
		// A message with a delayed auto-send (`pendingAutoSend`) has NOT enqueued
		// its send yet — it fires at `sendAt`. Measuring staleness from
		// `processedAt` (the approve time) would flag a legitimately-delayed send
		// as stuck the moment `processedAt` crossed the threshold, even though the
		// scheduled send is still pending in the future. Measure from `sendAt`
		// instead so a delayed-but-not-yet-due send is never re-fired; only once
		// its scheduled send time is itself past the staleness window (a genuinely
		// lost completion) does it become eligible.
		const stale = approved.filter((m) => {
			const base = m.pendingAutoSend?.sendAt ?? m.processedAt ?? m.receivedAt;
			return base <= cutoff;
		});
		if (stale.length === 0) return { reEnqueued: 0 };

		// One scan of the live queue: which inbound messages still have an
		// in-flight (`queued`) agent_reply send? Those are NOT stuck — their
		// completion is simply pending. The queued set is the small live tail.
		const queuedSends = await ctx.db
			.query('transactionalSends')
			.withIndex('by_status', (q) => q.eq('status', 'queued'))
			.take(500);
		const inFlight = new Set<string>();
		for (const send of queuedSends) {
			if (send.kind === 'agent_reply' && send.inboundMessageId) {
				inFlight.add(send.inboundMessageId);
			}
		}

		let reEnqueued = 0;
		for (const message of stale) {
			if (inFlight.has(message._id)) continue; // send still pending — leave it
			// Channel replies (sms/whatsapp/generic) complete via
			// channels.dispatchOutbound, NOT the transactionalSends queue — they
			// never have a queued send, so the "no queued send ⇒ lost" inference
			// doesn't hold and re-firing would re-dispatch (duplicate). Their
			// lifecycle is driven by dispatchOutbound; leave them.
			if (isOutboundChannel(message.to)) continue;
			// Lost completion: re-fire the approved-send effect. Idempotent against
			// duplication because we only reach here when no queued send remains.
			await ctx.scheduler.runAfter(
				0,
				internal.agent.agentPipeline.sendApprovedReply,
				{ inboundMessageId: message._id },
			);
			reEnqueued++;
		}

		return { reEnqueued };
	},
});

// ─── Delayed auto-send cancellation (undo window) ────────────────────────────
//
// Aborts an in-flight DELAYED autonomous auto-send before its undo window
// (`agentConfig.autoSendDelayMs`) elapses. Three callers:
//   - a landing inbound reply in the same thread (the queued reply is now
//     stale — the customer said more; see inbox/threads/module.ts),
//   - the autonomy kill switch (stop everything in flight),
//   - an explicit user "Undo" from the review surface.
//
// Cancelling the scheduled send routes the reply back to the human review
// queue (`approved → draft_ready`) rather than dropping it — the fail-soft
// degrade. Idempotent: a message with no `pendingAutoSend` marker (already
// sent, never delayed, or already cancelled) is a no-op.

export const cancelAutoSend = internalMutation({
	args: {
		inboundMessageId: v.id('inboundMessages'),
		reason: v.union(
			v.literal('thread_reply'),
			v.literal('kill_switch'),
			v.literal('user_cancel'),
		),
	},
	handler: async (
		ctx,
		args,
	): Promise<{ cancelled: boolean; reason: 'no_pending_send' | 'not_approved' | 'cancelled' }> => {
		const message = await ctx.db.get(args.inboundMessageId);
		if (!message) return { cancelled: false, reason: 'no_pending_send' };

		const pending = message.pendingAutoSend;
		if (!pending) return { cancelled: false, reason: 'no_pending_send' };

		// A marker only ever lives on an `approved` message; if the status has
		// already moved on (e.g. the send fired and completed), there is nothing
		// to cancel — leave the state alone.
		if (message.processingStatus !== 'approved') {
			return { cancelled: false, reason: 'not_approved' };
		}

		// Abort the delayed send. `scheduler.cancel` is a no-op if the job has
		// already run or been cancelled, so this is safe against a race with the
		// send firing at its deadline.
		await ctx.scheduler.cancel(pending.scheduledFnId);

		// Route back to human review. The `→ draft_ready` reducer clears the
		// pendingAutoSend marker (any transition out of `approved` does) and
		// projects the thread's draft status back to `pending`.
		await dispatch(ctx, message, { to: 'draft_ready', at: Date.now() });

		return { cancelled: true, reason: 'cancelled' };
	},
});
