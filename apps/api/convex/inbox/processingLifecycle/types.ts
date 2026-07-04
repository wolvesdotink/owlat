/**
 * Inbox processing lifecycle — typed contract (no logic).
 *
 * The `ProcessingStatus` / `ActionType` literal unions, the `TransitionInput`
 * discriminated union + its Convex validator, the `Effect` / `ReducerResult`
 * shapes the reducers produce, and the `TransitionOutcome` the dispatcher
 * returns. Pure types + validators — no runtime branching lives here. The
 * state graph and per-state reducers are in `./reducers.ts`; the effect runner
 * is in `./effects.ts`.
 *
 * See docs/adr/0010-inbox-processing-lifecycle-module.md.
 */

import { v, type Infer } from 'convex/values';
import type { Id } from '../../_generated/dataModel';
import {
	securityFlagsValidator,
	classificationValidator,
	tokenUsageValidator,
} from '../../lib/convexValidators';
import { pendingClarificationValidator } from '../clarificationValidators';
import { MAX_RETRY_ATTEMPTS } from '../../lib/constants';

// ─── Status / action literals ────────────────────────────────────────────────

export type ProcessingStatus =
	| 'received'
	| 'security_check'
	| 'quarantined'
	| 'classifying'
	| 'drafting'
	| 'draft_ready'
	| 'awaiting_clarification'
	| 'approved'
	| 'sent'
	| 'rejected'
	| 'archived'
	| 'failed';

export type ActionType = 'security_scan' | 'context_retrieval' | 'classify' | 'draft' | 'route';

export type ActionStatus = 'pending' | 'running' | 'completed' | 'failed' | 'abandoned' | 'skipped';

/**
 * Terminal status for a just-failed agentAction. `failed` stays RETRYABLE and
 * is what the retry cron (processingLifecycle.retryFailedActions) scans via
 * `by_status`; `abandoned` is the true terminal state, applied the moment
 * retries are exhausted. Keeping exhausted rows OUT of the `failed` bucket
 * stops the ascending `by_status='failed'` scan from being permanently starved
 * by a growing head of lifetime-exhausted rows.
 *
 * `newRetryCount` is the incremented count being written on THIS failure
 * (i.e. `action.retryCount + 1`).
 */
export function failedActionStatus(newRetryCount: number): ActionStatus {
	return newRetryCount >= MAX_RETRY_ATTEMPTS ? 'abandoned' : 'failed';
}

// Derived from the shared validators (single source of truth — also spread into
// the inboundMessages / agentActions schema columns). A local hand-written copy
// here used to drift, e.g. the `guardUnavailable` field had to be added twice.
export type SecurityFlags = Infer<typeof securityFlagsValidator>;
export type Classification = Infer<typeof classificationValidator>;
export type TokenUsage = Infer<typeof tokenUsageValidator>;
export type PendingClarification = Infer<typeof pendingClarificationValidator>;

export const actionTypeValidator = v.union(
	v.literal('security_scan'),
	v.literal('context_retrieval'),
	v.literal('classify'),
	v.literal('clarify'),
	v.literal('draft'),
	v.literal('route')
);

// ─── TransitionInput ────────────────────────────────────────────────────────
//
// Discriminated by `to`. Optional `completedActionId` completes the
// running agentAction (atomic with the status patch). Optional fields
// (`securityFlags`, `classification`, `draftResponse`, etc.) are stored
// on the message in the same patch.

export type TransitionInput =
	| { to: 'security_check'; at: number }
	| {
			to: 'classifying';
			at: number;
			completedActionId?: Id<'agentActions'>;
			output?: string;
			securityFlags?: SecurityFlags;
			contextTier?: 'normal' | 'compacted' | 'emergency';
			durationMs?: number;
			modelUsed?: string;
			tokenUsage?: TokenUsage;
	  }
	| {
			to: 'drafting';
			at: number;
			completedActionId?: Id<'agentActions'>;
			output?: string;
			classification?: Classification;
			durationMs?: number;
			modelUsed?: string;
			tokenUsage?: TokenUsage;
	  }
	| {
			to: 'draft_ready';
			at: number;
			completedActionId?: Id<'agentActions'>;
			output?: string;
			draftResponse?: string;
			draftSubject?: string;
			confidenceScore?: number;
			classification?: Classification;
			durationMs?: number;
			modelUsed?: string;
			tokenUsage?: TokenUsage;
	  }
	| {
			to: 'awaiting_clarification';
			at: number;
			completedActionId?: Id<'agentActions'>;
			output?: string;
			pendingClarification?: PendingClarification;
			classification?: Classification;
			durationMs?: number;
			modelUsed?: string;
			tokenUsage?: TokenUsage;
	  }
	| {
			to: 'quarantined';
			at: number;
			completedActionId?: Id<'agentActions'>;
			securityFlags: SecurityFlags;
			output?: string;
			durationMs?: number;
	  }
	| {
			to: 'archived';
			at: number;
			completedActionId?: Id<'agentActions'>;
			reason:
				| 'spam'
				| 'sender_blocked'
				| 'classifier_spam'
				| 'handling_rule_archive'
				| 'coalesced'
				| 'clarification_dismissed';
			securityFlags?: SecurityFlags;
			userId?: string;
			output?: string;
			durationMs?: number;
	  }
	| {
			to: 'approved';
			at: number;
			source: 'human' | 'auto';
			userId?: string;
			completedActionId?: Id<'agentActions'>;
			output?: string;
	  }
	| { to: 'sent'; at: number }
	| {
			to: 'rejected';
			at: number;
			userId: string;
			reason?: string;
	  }
	| {
			to: 'received';
			at: number;
			source: 'release_quarantine' | 'cron_retry';
			userId?: string;
			resetActionId?: Id<'agentActions'>;
	  }
	| {
			to: 'failed';
			at: number;
			errorMessage: string;
			failingActionId?: Id<'agentActions'>;
	  };

export type TransitionOutcome =
	| {
			ok: true;
			applied: 'transitioned' | 'recorded';
			from: ProcessingStatus;
			to: ProcessingStatus;
	  }
	| {
			ok: false;
			reason: 'message_not_found' | 'illegal_edge' | 'terminal';
			from?: ProcessingStatus;
			to?: ProcessingStatus;
	  };

// ─── Validator ──────────────────────────────────────────────────────────────

export const transitionInputValidator = v.union(
	v.object({ to: v.literal('security_check'), at: v.number() }),
	v.object({
		to: v.literal('classifying'),
		at: v.number(),
		completedActionId: v.optional(v.id('agentActions')),
		output: v.optional(v.string()),
		securityFlags: v.optional(securityFlagsValidator),
		contextTier: v.optional(
			v.union(v.literal('normal'), v.literal('compacted'), v.literal('emergency'))
		),
		durationMs: v.optional(v.number()),
		modelUsed: v.optional(v.string()),
		tokenUsage: v.optional(tokenUsageValidator),
	}),
	v.object({
		to: v.literal('drafting'),
		at: v.number(),
		completedActionId: v.optional(v.id('agentActions')),
		output: v.optional(v.string()),
		classification: v.optional(classificationValidator),
		durationMs: v.optional(v.number()),
		modelUsed: v.optional(v.string()),
		tokenUsage: v.optional(tokenUsageValidator),
	}),
	v.object({
		to: v.literal('draft_ready'),
		at: v.number(),
		completedActionId: v.optional(v.id('agentActions')),
		output: v.optional(v.string()),
		draftResponse: v.optional(v.string()),
		draftSubject: v.optional(v.string()),
		confidenceScore: v.optional(v.number()),
		classification: v.optional(classificationValidator),
		durationMs: v.optional(v.number()),
		modelUsed: v.optional(v.string()),
		tokenUsage: v.optional(tokenUsageValidator),
	}),
	v.object({
		to: v.literal('awaiting_clarification'),
		at: v.number(),
		completedActionId: v.optional(v.id('agentActions')),
		output: v.optional(v.string()),
		pendingClarification: v.optional(pendingClarificationValidator),
		classification: v.optional(classificationValidator),
		durationMs: v.optional(v.number()),
		modelUsed: v.optional(v.string()),
		tokenUsage: v.optional(tokenUsageValidator),
	}),
	v.object({
		to: v.literal('quarantined'),
		at: v.number(),
		completedActionId: v.optional(v.id('agentActions')),
		securityFlags: securityFlagsValidator,
		output: v.optional(v.string()),
		durationMs: v.optional(v.number()),
	}),
	v.object({
		to: v.literal('archived'),
		at: v.number(),
		completedActionId: v.optional(v.id('agentActions')),
		reason: v.union(
			v.literal('spam'),
			v.literal('sender_blocked'),
			v.literal('classifier_spam'),
			v.literal('handling_rule_archive'),
			v.literal('coalesced'),
			v.literal('clarification_dismissed')
		),
		securityFlags: v.optional(securityFlagsValidator),
		userId: v.optional(v.string()),
		output: v.optional(v.string()),
		durationMs: v.optional(v.number()),
	}),
	v.object({
		to: v.literal('approved'),
		at: v.number(),
		source: v.union(v.literal('human'), v.literal('auto')),
		userId: v.optional(v.string()),
		completedActionId: v.optional(v.id('agentActions')),
		output: v.optional(v.string()),
	}),
	v.object({ to: v.literal('sent'), at: v.number() }),
	v.object({
		to: v.literal('rejected'),
		at: v.number(),
		userId: v.string(),
		reason: v.optional(v.string()),
	}),
	v.object({
		to: v.literal('received'),
		at: v.number(),
		source: v.union(v.literal('release_quarantine'), v.literal('cron_retry')),
		userId: v.optional(v.string()),
		resetActionId: v.optional(v.id('agentActions')),
	}),
	v.object({
		to: v.literal('failed'),
		at: v.number(),
		errorMessage: v.string(),
		failingActionId: v.optional(v.id('agentActions')),
	})
);

// ─── Effects ────────────────────────────────────────────────────────────────

export type Effect =
	| {
			kind: 'complete_action';
			actionId: Id<'agentActions'>;
			output: string | undefined;
			durationMs: number | undefined;
			modelUsed: string | undefined;
			tokenUsage: TokenUsage | undefined;
	  }
	| {
			kind: 'fail_action';
			actionId: Id<'agentActions'>;
			errorMessage: string;
	  }
	| {
			kind: 'reset_action_to_pending';
			actionId: Id<'agentActions'>;
	  }
	| {
			kind: 'set_thread_draft_status';
			threadId: Id<'conversationThreads'>;
			draftStatus: 'pending' | 'approved' | 'rejected' | 'sent';
	  }
	| {
			kind: 'schedule_send_approved';
			inboundMessageId: Id<'inboundMessages'>;
			// True when the approval was autonomous (route step, `source: 'auto'`).
			// The send path runs the deterministic pre-send reference monitor only
			// on this path; human-reviewed sends are unchanged.
			autonomous: boolean;
	  }
	| {
			kind: 'schedule_pipeline_start';
			inboundMessageId: Id<'inboundMessages'>;
	  }
	| {
			kind: 'schedule_knowledge_extraction';
			inboundMessageId: Id<'inboundMessages'>;
	  }
	| {
			kind: 'schedule_code_task';
			inboundMessageId: Id<'inboundMessages'>;
	  }
	| {
			kind: 'increment_auto_reply_count';
	  };

export type ReducerResult = {
	patch: Record<string, unknown>;
	effects: Effect[];
	applied: 'transitioned' | 'recorded';
};

/** The input variant for a given target state. */
export type InputFor<T extends ProcessingStatus> = Extract<TransitionInput, { to: T }>;

/** A builder's contribution beyond the base `processingStatus`/`processedAt`. */
export type TransitionParts = { patch: Record<string, unknown>; effects: Effect[] };
