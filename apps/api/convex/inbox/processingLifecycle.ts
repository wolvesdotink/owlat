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
 * under the size cap. The status-owning mutations keep their
 * `internal.inbox.processingLifecycle.*` paths; the in-state step-output mirror
 * mutations (recordContextTier / recordAgentDecision / recordDraftOutput —
 * which persist a step's result onto its inboundMessage WITHOUT changing
 * processingStatus) live in the sibling `./stepOutputs.ts`
 * (`internal.inbox.stepOutputs.*`), split out to hold this file under the cap.
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
import { isOutboundChannel, tokenUsageValidator } from '../lib/convexValidators';
import {
	actionTypeValidator,
	failedActionStatus,
	transitionInputValidator,
	type TransitionOutcome,
} from './processingLifecycle/types';
import { dispatch } from './processingLifecycle/effects';
import { MAX_RETRY_ATTEMPTS } from '../lib/constants';
import {
	cancelPendingAutoSend,
	cancelAutoSendReasonValidator,
	type CancelAutoSendOutcome,
} from './processingLifecycle/autoSendCancel';

// Re-export the lifecycle types so existing cross-file importers
// (`agent/steps/*`, tests) keep a single import surface.
export type {
	ProcessingStatus,
	ActionType,
	ActionStatus,
	TransitionInput,
	TransitionOutcome,
} from './processingLifecycle/types';

// Re-export the auto-send-cancel outcome type so cross-file importers
// (`inbox/mutations.ts`) keep importing it from this module surface.
export type { CancelAutoSendOutcome } from './processingLifecycle/autoSendCancel';

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
		const retryCount = action.retryCount + 1;
		await ctx.db.patch(args.actionId, {
			// Once retries are exhausted the row becomes terminally `abandoned`
			// so the retry cron's `by_status='failed'` scan is never starved by a
			// growing head of lifetime-exhausted failures.
			status: failedActionStatus(retryCount),
			errorMessage: args.errorMessage,
			completedAt: Date.now(),
			retryCount,
		});
	},
});

// The in-state step-output mirror mutations (recordContextTier /
// recordAgentDecision / recordDraftOutput — persist a step's result onto its
// inboundMessage WITHOUT changing processingStatus) live in the sibling
// `./stepOutputs.ts`, split out to keep this dispatcher under the size cap. They
// are NOT part of `transition()`'s atomic status write; their generated paths
// are `internal.inbox.stepOutputs.*`.

// ─── Cron-driven retry ──────────────────────────────────────────────────────
//
// Replaces `agent/agentPipeline.retryFailedActions`. Resets failed
// agentActions whose `retryCount < MAX_RETRY_ATTEMPTS` and brings their
// inboundMessages back to 'received' atomically via the lifecycle.
//
// INVARIANT: retry-exhausted rows are written as `abandoned` (see
// `failedActionStatus`), NOT `failed`, so this ascending `by_status='failed'`
// scan can't be starved by a growing head of lifetime-exhausted rows. The
// `retryCount >= MAX_RETRY_ATTEMPTS` guard below is now belt-and-suspenders.

export const retryFailedActions = internalMutation({
	args: {},
	handler: async (ctx) => {
		const failedActions = await ctx.db
			.query('agentActions')
			.withIndex('by_status', (q) => q.eq('status', 'failed'))
			.take(20);

		const now = Date.now();

		for (const action of failedActions) {
			if (action.retryCount >= MAX_RETRY_ATTEMPTS) continue;
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

// ─── Abandoned-clarification fallback ────────────────────────────────────────
//
// A message parked in `awaiting_clarification` waits on a human answer. If the
// owner never answers, it must not wedge there forever: after a configurable
// window this cron gives up, marks the message so it can NEVER be auto-sent
// (`isAutoSendBlocked`), routes it `awaiting_clarification → drafting`, and
// re-enters the draft step with NO confirmed answers — producing a flagged
// best-guess draft that always lands in the human review queue. Same fail-soft
// posture as the stuck-approved reconcile: on uncertainty, degrade to human
// review, never auto-send.

/** Default window before an unanswered clarification is drafted as a best-guess.
 * Overridable per-deployment via `agentConfig.clarificationTimeoutMs`. */
export const DEFAULT_CLARIFICATION_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours

export const reconcileAbandonedClarifications = internalMutation({
	args: {},
	handler: async (ctx): Promise<{ resumed: number }> => {
		const configs = await ctx.db.query('agentConfig').take(1);
		const windowMs = Math.max(
			0,
			configs[0]?.clarificationTimeoutMs ?? DEFAULT_CLARIFICATION_TIMEOUT_MS,
		);
		const cutoff = Date.now() - windowMs;

		const awaiting = await ctx.db
			.query('inboundMessages')
			.withIndex('by_processing_status', (q) =>
				q.eq('processingStatus', 'awaiting_clarification'),
			)
			.take(100);

		let resumed = 0;
		for (const message of awaiting) {
			// Measure the abandonment window from when the questions were asked;
			// fall back to processedAt / receivedAt if a row predates the field.
			const askedAt =
				message.pendingClarification?.askedAt ??
				message.processedAt ??
				message.receivedAt;
			if (askedAt > cutoff) continue;

			// Mark the draft as never-auto-send-eligible BEFORE the transition, so
			// even if the resumed draft races to the route step the safety gate
			// (assertSafeToAutoSend) already sees the block. Direct patch of an
			// advisory field — the processingStatus change goes through dispatch.
			await ctx.db.patch(message._id, { isAutoSendBlocked: true });

			const outcome = await dispatch(ctx, message, {
				to: 'drafting',
				at: Date.now(),
			});
			if (!outcome.ok) continue;

			await ctx.scheduler.runAfter(0, internal.agent.walker.resumeDraft, {
				inboundMessageId: message._id,
			});
			resumed++;
		}

		return { resumed };
	},
});

// ─── Delayed auto-send cancellation (undo window) ────────────────────────────
//
// The shared cancel core (`cancelPendingAutoSend`) and its types live in
// `./processingLifecycle/autoSendCancel.ts` — split out to keep this dispatcher
// under the size cap, mirroring the reducers / effects / types split. The two
// public mutations that expose it stay here.

export const cancelAutoSend = internalMutation({
	args: {
		inboundMessageId: v.id('inboundMessages'),
		reason: cancelAutoSendReasonValidator,
		// Operator behind an explicit user Undo; absent for system-initiated
		// cancels (landing reply / kill switch).
		userId: v.optional(v.string()),
	},
	handler: async (ctx, args): Promise<CancelAutoSendOutcome> => {
		const message = await ctx.db.get(args.inboundMessageId);
		if (!message) return { cancelled: false, reason: 'no_pending_send' };
		return cancelPendingAutoSend(ctx, message, args.reason, args.userId);
	},
});

// ─── Kill-switch bulk cancel ─────────────────────────────────────────────────
//
// When the operator flips the auto-reply kill switch off (updateConfig sets
// `isAutoReplyEnabled=false`), every autonomous send still sitting in its undo
// window must be pulled back — otherwise a queued send fires seconds after the
// operator thought they stopped it. Scan the `approved` messages and cancel any
// that still hold a live `pendingAutoSend` marker, routing each back to human
// review. Scheduled off the admin mutation so a large scan never blocks the
// config write; fail-soft per message.

export const cancelPendingAutoSendsForKillSwitch = internalMutation({
	args: {},
	handler: async (ctx): Promise<{ cancelled: number }> => {
		const approved = await ctx.db
			.query('inboundMessages')
			.withIndex('by_processing_status', (q) => q.eq('processingStatus', 'approved'))
			.take(100);

		let cancelled = 0;
		for (const message of approved) {
			if (!message.pendingAutoSend) continue;
			const outcome = await cancelPendingAutoSend(ctx, message, 'kill_switch');
			if (outcome.cancelled) cancelled++;
		}
		return { cancelled };
	},
});
