/**
 * Inbox processing lifecycle — pure state-graph + per-state reducers.
 *
 * The side-effect-free half of the lifecycle: the `LEGAL_EDGES` graph, the
 * terminal-state set, and the per-state reducers that map
 * `(message, input) → { patch, effects }`. It touches neither `ctx.db` nor
 * `ctx.scheduler` — the effect runner in `./effects.ts` is the only place that
 * does. The typed contract (status/action literals, `TransitionInput` union +
 * validator, `Effect` shapes) lives in `./types.ts`. Splitting the reducers out
 * keeps the dispatcher file (`../processingLifecycle.ts`) under the size cap and
 * lets the reducers be reasoned about (and unit-tested) without a DB fixture.
 *
 * See docs/adr/0010-inbox-processing-lifecycle-module.md.
 */

import type { Doc, Id } from '../../_generated/dataModel';
import type {
	Effect,
	InputFor,
	ProcessingStatus,
	ReducerResult,
	TokenUsage,
	TransitionInput,
	TransitionParts,
} from './types';

// ─── Legal-edges graph ──────────────────────────────────────────────────────
//
// Block-sender / pipeline errors / quarantine-release / cron-retry use a
// star-source pattern handled at the dispatcher. The `planning` state
// and `plan` action type were dropped pre-prod with ADR-0014 — they were
// vestigial (the classifier never transitioned to `planning`; the drafter
// wrote a `plan` row whose payload was JSON literal construction).

export const LEGAL_EDGES: Record<ProcessingStatus, ReadonlySet<ProcessingStatus>> = {
	// `archived` here documents coalescing supersession (agent/coalescing.ts
	// archives superseded `received` messages with reason 'coalesced'). The
	// `* → archived` star-source branch in dispatch() already permits it; this
	// entry keeps the declared contract in sync with runtime behavior.
	received: new Set<ProcessingStatus>(['security_check', 'archived']),
	security_check: new Set<ProcessingStatus>([
		'classifying',
		'quarantined',
		'archived',
	]),
	quarantined: new Set<ProcessingStatus>(['received', 'archived']),
	classifying: new Set<ProcessingStatus>([
		'drafting',
		'draft_ready',
		'archived',
	]),
	drafting: new Set<ProcessingStatus>(['draft_ready', 'approved']),
	draft_ready: new Set<ProcessingStatus>(['approved', 'rejected', 'archived']),
	// `draft_ready` is the fail-soft degrade for a cancelled delayed auto-send
	// (cancelAutoSend): aborting the in-flight send routes the reply back to the
	// human review queue rather than silently dropping it.
	approved: new Set<ProcessingStatus>(['sent', 'draft_ready']),
	sent: new Set<ProcessingStatus>(),
	rejected: new Set<ProcessingStatus>(),
	archived: new Set<ProcessingStatus>(),
	failed: new Set<ProcessingStatus>(['received']),
};

export const TERMINAL: ReadonlySet<ProcessingStatus> = new Set([
	'sent',
	'rejected',
	'archived',
]);

// `to: 'failed'` can come from any non-terminal source; checked separately.
export function canFail(from: ProcessingStatus): boolean {
	return !TERMINAL.has(from);
}

// ─── Reducer ────────────────────────────────────────────────────────────────
//
// One small builder per target state — mirrors the per-state reducers in the
// sibling lifecycles (delivery/sendLifecycle.ts, mail/draftLifecycle.ts) rather
// than one 200-line switch. Each builder receives the narrowed input and
// returns the patch fields and effects for that edge; `reduce` is the thin
// dispatcher that adds the shared base patch and fans out.

/** The `complete_action` effect that records a finished agent action. Different
 * edges carry different metrics — drafting edges have full timing/model/token
 * data; quarantine/archive only duration; approval none — so they're passed
 * explicitly rather than read off the union. */
function completeAction(
	actionId: Id<'agentActions'>,
	output: string | undefined,
	metrics: { durationMs?: number; modelUsed?: string; tokenUsage?: TokenUsage } = {},
): Effect {
	return {
		kind: 'complete_action',
		actionId,
		output,
		durationMs: metrics.durationMs,
		modelUsed: metrics.modelUsed,
		tokenUsage: metrics.tokenUsage,
	};
}

function reduceClassifying(_message: Doc<'inboundMessages'>, input: InputFor<'classifying'>): TransitionParts {
	const patch: Record<string, unknown> = {};
	const effects: Effect[] = [];
	if (input.completedActionId) {
		effects.push(
			completeAction(input.completedActionId, input.output, {
				durationMs: input.durationMs,
				modelUsed: input.modelUsed,
				tokenUsage: input.tokenUsage,
			}),
		);
	}
	if (input.securityFlags) patch['securityFlags'] = input.securityFlags;
	if (input.contextTier) patch['contextTier'] = input.contextTier;
	return { patch, effects };
}

function reduceDrafting(message: Doc<'inboundMessages'>, input: InputFor<'drafting'>): TransitionParts {
	const patch: Record<string, unknown> = {};
	const effects: Effect[] = [];
	if (input.completedActionId) {
		effects.push(
			completeAction(input.completedActionId, input.output, {
				durationMs: input.durationMs,
				modelUsed: input.modelUsed,
				tokenUsage: input.tokenUsage,
			}),
		);
	}
	if (input.classification) {
		patch['classification'] = input.classification;
		patch['confidenceScore'] = input.classification.confidence;
	}
	// Classification has completed (classifying → drafting) — mine the inbound
	// message for organizational knowledge (the "self-building" graph). Fires
	// exactly once per message; the drafting → draft_ready edge does NOT re-fire.
	effects.push({ kind: 'schedule_knowledge_extraction', inboundMessageId: message._id });
	// Feature requests flow to engineering as code-work tasks (the "customer
	// request in → PR out" loop). Gated on inbox.codeTasks inside the scheduled
	// mutation.
	if (input.classification?.category === 'feature_request') {
		effects.push({ kind: 'schedule_code_task', inboundMessageId: message._id });
	}
	return { patch, effects };
}

function reduceDraftReady(message: Doc<'inboundMessages'>, input: InputFor<'draft_ready'>): TransitionParts {
	const patch: Record<string, unknown> = {};
	const effects: Effect[] = [];
	if (input.completedActionId) {
		effects.push(
			completeAction(input.completedActionId, input.output, {
				durationMs: input.durationMs,
				modelUsed: input.modelUsed,
				tokenUsage: input.tokenUsage,
			}),
		);
	}
	if (input.classification) patch['classification'] = input.classification;
	if (input.draftResponse !== undefined) patch['draftResponse'] = input.draftResponse;
	if (input.draftSubject !== undefined) patch['draftSubject'] = input.draftSubject;
	if (input.confidenceScore !== undefined) patch['confidenceScore'] = input.confidenceScore;
	// Complaint / urgent messages skip the drafter (classifying → draft_ready),
	// so they'd otherwise miss extraction. Fire it here only on that direct edge
	// — the normal drafting → draft_ready transition already extracted at
	// classifying → drafting.
	if (message.processingStatus === 'classifying') {
		effects.push({ kind: 'schedule_knowledge_extraction', inboundMessageId: message._id });
		if (input.classification?.category === 'feature_request') {
			effects.push({ kind: 'schedule_code_task', inboundMessageId: message._id });
		}
	}
	if (message.threadId) {
		effects.push({ kind: 'set_thread_draft_status', threadId: message.threadId, draftStatus: 'pending' });
	}
	return { patch, effects };
}

function reduceQuarantined(_message: Doc<'inboundMessages'>, input: InputFor<'quarantined'>): TransitionParts {
	const effects: Effect[] = [];
	if (input.completedActionId) {
		effects.push(completeAction(input.completedActionId, input.output, { durationMs: input.durationMs }));
	}
	return { patch: { securityFlags: input.securityFlags }, effects };
}

function reduceArchived(_message: Doc<'inboundMessages'>, input: InputFor<'archived'>): TransitionParts {
	const patch: Record<string, unknown> = {};
	const effects: Effect[] = [];
	if (input.completedActionId) {
		effects.push(completeAction(input.completedActionId, input.output, { durationMs: input.durationMs }));
	}
	if (input.securityFlags) patch['securityFlags'] = input.securityFlags;
	return { patch, effects };
}

function reduceApproved(message: Doc<'inboundMessages'>, input: InputFor<'approved'>): TransitionParts {
	const effects: Effect[] = [];
	if (input.completedActionId) {
		effects.push(completeAction(input.completedActionId, input.output));
	}
	// Schedule the actual send via the agent pipeline's send action. Flag the
	// autonomous path so the send action runs the deterministic pre-send
	// reference monitor (recipient lock + DLP + HTML sanitize) only for
	// unattended sends; human-reviewed approvals send unchanged.
	effects.push({
		kind: 'schedule_send_approved',
		inboundMessageId: message._id,
		autonomous: input.source === 'auto',
	});
	if (input.source === 'auto') {
		effects.push({ kind: 'increment_auto_reply_count' });
	}
	if (message.threadId) {
		effects.push({ kind: 'set_thread_draft_status', threadId: message.threadId, draftStatus: 'approved' });
	}
	return { patch: {}, effects };
}

function reduceThreadStatusOnly(
	message: Doc<'inboundMessages'>,
	draftStatus: 'sent' | 'rejected',
): TransitionParts {
	const effects: Effect[] = [];
	if (message.threadId) {
		effects.push({ kind: 'set_thread_draft_status', threadId: message.threadId, draftStatus });
	}
	return { patch: {}, effects };
}

function reduceReceived(message: Doc<'inboundMessages'>, input: InputFor<'received'>): TransitionParts {
	// Reset path: clear the failure / quarantine fields so the next pipeline pass
	// starts clean, and re-kick the Agent walker from `security_scan`. The
	// schedule_pipeline_start effect closes the latent bug (ADR-0014 drift bug
	// #6) where the release-from-quarantine and cron-retry paths reset state but
	// no caller re-scheduled the pipeline.
	const patch: Record<string, unknown> = { errorMessage: undefined };
	const effects: Effect[] = [];
	if (input.source === 'release_quarantine') {
		patch['securityFlags'] = undefined;
	}
	if (input.resetActionId) {
		effects.push({ kind: 'reset_action_to_pending', actionId: input.resetActionId });
	}
	effects.push({ kind: 'schedule_pipeline_start', inboundMessageId: message._id });
	return { patch, effects };
}

function reduceFailed(_message: Doc<'inboundMessages'>, input: InputFor<'failed'>): TransitionParts {
	const patch: Record<string, unknown> = { errorMessage: input.errorMessage };
	const effects: Effect[] = [];
	if (input.failingActionId) {
		effects.push({ kind: 'fail_action', actionId: input.failingActionId, errorMessage: input.errorMessage });
	}
	return { patch, effects };
}

/** Per-state patch + effects for a transition. Exhaustive over TransitionInput. */
function buildTransition(message: Doc<'inboundMessages'>, input: TransitionInput): TransitionParts {
	switch (input.to) {
		case 'security_check':
			return { patch: {}, effects: [] };
		case 'classifying':
			return reduceClassifying(message, input);
		case 'drafting':
			return reduceDrafting(message, input);
		case 'draft_ready':
			return reduceDraftReady(message, input);
		case 'quarantined':
			return reduceQuarantined(message, input);
		case 'archived':
			return reduceArchived(message, input);
		case 'approved':
			return reduceApproved(message, input);
		case 'sent':
			return reduceThreadStatusOnly(message, 'sent');
		case 'rejected':
			return reduceThreadStatusOnly(message, 'rejected');
		case 'received':
			return reduceReceived(message, input);
		case 'failed':
			return reduceFailed(message, input);
	}
}

const PROCESSED_AT_STATES: ReadonlySet<ProcessingStatus> = new Set([
	'approved',
	'sent',
	'rejected',
	'archived',
	'failed',
]);

export function reduce(message: Doc<'inboundMessages'>, input: TransitionInput): ReducerResult {
	const patch: Record<string, unknown> = { processingStatus: input.to };
	if (PROCESSED_AT_STATES.has(input.to)) {
		patch['processedAt'] = input.at;
	}
	// Any transition OUT of `approved` closes the delayed-auto-send undo window,
	// so clear the cancellable pending-send marker. Covers `→ sent` (delivered),
	// `→ failed` (pre-flight error), and `→ draft_ready` (cancelAutoSend). The
	// reducers below may re-set it via the `schedule_send_approved` effect on the
	// way IN to `approved`; this only fires on the way out.
	if (message.processingStatus === 'approved' && input.to !== 'approved') {
		patch['pendingAutoSend'] = undefined;
	}

	const parts = buildTransition(message, input);
	Object.assign(patch, parts.patch);
	return { patch, effects: parts.effects, applied: 'transitioned' };
}
