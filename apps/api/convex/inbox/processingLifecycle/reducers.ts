/**
 * Inbox processing lifecycle — pure state-graph + per-state reducers.
 *
 * The side-effect-free half of the lifecycle: the `PROCESSING_LIFECYCLE` edge
 * graph (declared through the generic lifecycle core, which derives the
 * terminal states from it) and the per-state reducers that map
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
import { defineLifecycle } from '../../lib/lifecycle';
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
//
// The graph itself lives in the generic lifecycle core (`lib/lifecycle.ts`,
// ADR-0058); the reducers below and the effect runner in `./effects.ts` stay
// where they are. `sent` declares no outgoing edges, which is what makes it
// terminal. `rejected` and `archived` are CLOSED rather than terminal: their
// one outgoing edge is a person reopening the message to write the reply
// themselves (`→ draft_ready`, inbox/manualReply.ts). Every other move out of a
// closed state — the pipeline failing it, archiving it again, a stray walker
// step — is refused with the same `terminal` reason as before (see
// `isClosedStatus`).

export const PROCESSING_LIFECYCLE = defineLifecycle<ProcessingStatus>(
	{
		// `archived` here documents coalescing supersession (agent/coalescing.ts
		// archives superseded `received` messages with reason 'coalesced'). The
		// `* → archived` star-source branch in dispatch() already permits it; this
		// entry keeps the declared contract in sync with runtime behavior.
		// `draft_ready` is the human takeover of a message the pipeline never
		// picked up: automated/self-send mail and mail over the agent cost cap stay
		// in `received` without a walker run (inbox/messages.ts), and a person can
		// still answer it (inbox/manualReply.ts gates when).
		received: ['security_check', 'archived', 'draft_ready'],
		// `draft_ready` is the human takeover (inbox/manualReply.ts): with the
		// agent off the pipeline stops after a clean scan, and a person writes the
		// reply themselves. The mutation only takes this edge once the scan has
		// finished, so a message is never answered ahead of its quarantine check.
		security_check: ['classifying', 'quarantined', 'archived', 'draft_ready'],
		quarantined: ['received', 'archived'],
		classifying: ['drafting', 'draft_ready', 'awaiting_clarification', 'informational', 'archived'],
		// Needs no reply: parked for the Updates dashboard. A reader can dismiss
		// it (`archived`, reason 'update_dismissed') or overrule the classifier
		// and ask for a draft after all (`drafting`, via walker.resumeDraft).
		informational: ['drafting', 'archived'],
		// The clarification loop: parked awaiting an owner answer. Resumes into
		// `drafting` two ways — the owner answers (`answerClarification`), or the
		// abandoned-question fallback cron gives up after the window and drafts a
		// flagged best-guess. `archived` is the dismiss edge (permitted uniformly by
		// the `* → archived` star-source in dispatch; declared here to keep the
		// contract in sync).
		awaiting_clarification: ['drafting', 'archived'],
		drafting: ['draft_ready', 'approved'],
		draft_ready: ['approved', 'rejected', 'archived'],
		// `draft_ready` is the fail-soft degrade for a cancelled delayed auto-send
		// (cancelAutoSend): aborting the in-flight send routes the reply back to the
		// human review queue rather than silently dropping it.
		approved: ['sent', 'draft_ready'],
		sent: [],
		// A person reopens a rejected draft or an archived message to write the
		// reply themselves (inbox/manualReply.ts).
		rejected: ['draft_ready'],
		archived: ['draft_ready'],
		// `received` is the retry; `draft_ready` is a person writing the reply
		// the agent failed to (inbox/manualReply.ts).
		failed: ['received', 'draft_ready'],
	},
	{ reportsTerminalRefusals: true }
);

/**
 * Closed: nothing more happens to the message unless a person reopens it
 * (`rejected`/`archived` → `draft_ready`). The star-source edges (`→ failed`,
 * `→ archived`) and refusal reasons treat these exactly like the terminal
 * `sent`.
 */
const CLOSED_STATES: ReadonlySet<ProcessingStatus> = new Set(['sent', 'rejected', 'archived']);

export function isClosedStatus(status: ProcessingStatus): boolean {
	return CLOSED_STATES.has(status) || PROCESSING_LIFECYCLE.isTerminal(status);
}

/**
 * States only a person may move to `draft_ready` (with `manualTakeover`): the
 * closed ones, and `received`, which the pipeline would otherwise leave
 * through `security_check`.
 */
const TAKEOVER_ONLY_SOURCES: ReadonlySet<ProcessingStatus> = new Set([
	'received',
	'rejected',
	'archived',
]);

/** Closed states whose leftover draft a manual takeover discards. */
const CLEARS_DRAFT_ON_TAKEOVER: ReadonlySet<ProcessingStatus> = new Set(['rejected', 'archived']);

export function requiresManualTakeover(from: ProcessingStatus, to: ProcessingStatus): boolean {
	return to === 'draft_ready' && TAKEOVER_ONLY_SOURCES.has(from);
}

// `to: 'failed'` can come from any open source; checked separately.
export function canFail(from: ProcessingStatus): boolean {
	return !isClosedStatus(from);
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
	metrics: { durationMs?: number; modelUsed?: string; tokenUsage?: TokenUsage } = {}
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

function reduceClassifying(
	_message: Doc<'inboundMessages'>,
	input: InputFor<'classifying'>
): TransitionParts {
	const patch: Record<string, unknown> = {};
	const effects: Effect[] = [];
	if (input.completedActionId) {
		effects.push(
			completeAction(input.completedActionId, input.output, {
				durationMs: input.durationMs,
				modelUsed: input.modelUsed,
				tokenUsage: input.tokenUsage,
			})
		);
	}
	if (input.securityFlags) patch['securityFlags'] = input.securityFlags;
	if (input.contextTier) patch['contextTier'] = input.contextTier;
	return { patch, effects };
}

function reduceDrafting(
	message: Doc<'inboundMessages'>,
	input: InputFor<'drafting'>
): TransitionParts {
	const patch: Record<string, unknown> = {};
	const effects: Effect[] = [];
	if (input.completedActionId) {
		effects.push(
			completeAction(input.completedActionId, input.output, {
				durationMs: input.durationMs,
				modelUsed: input.modelUsed,
				tokenUsage: input.tokenUsage,
			})
		);
	}
	if (input.classification) {
		patch['classification'] = input.classification;
		patch['confidenceScore'] = input.classification.confidence;
	}
	// Classification has completed (classifying → drafting) — mine the inbound
	// message for organizational knowledge (the "self-building" graph). Fires
	// exactly once per message; the drafting → draft_ready edge does NOT re-fire,
	// and neither does a reader's `informational → drafting` overrule (the
	// informational edge already extracted).
	if (message.processingStatus !== 'informational') {
		effects.push({ kind: 'schedule_knowledge_extraction', inboundMessageId: message._id });
	}
	// Feature requests flow to engineering as code-work tasks (the "customer
	// request in → PR out" loop). Gated on inbox.codeTasks inside the scheduled
	// mutation.
	if (input.classification?.category === 'feature_request') {
		effects.push({ kind: 'schedule_code_task', inboundMessageId: message._id });
	}
	return { patch, effects };
}

function reduceDraftReady(
	message: Doc<'inboundMessages'>,
	input: InputFor<'draft_ready'>
): TransitionParts {
	const patch: Record<string, unknown> = {};
	const effects: Effect[] = [];
	if (input.completedActionId) {
		effects.push(
			completeAction(input.completedActionId, input.output, {
				durationMs: input.durationMs,
				modelUsed: input.modelUsed,
				tokenUsage: input.tokenUsage,
			})
		);
	}
	if (input.classification) patch['classification'] = input.classification;
	if (input.draftResponse !== undefined) patch['draftResponse'] = input.draftResponse;
	if (input.draftSubject !== undefined) patch['draftSubject'] = input.draftSubject;
	if (input.confidenceScore !== undefined) patch['confidenceScore'] = input.confidenceScore;
	// A person reopening a closed message writes the reply themselves. The draft
	// it still carries was thrown out (rejected) or never used (archived); left
	// in place it would come back as a live, approvable agent draft.
	if (input.manualTakeover === true && CLEARS_DRAFT_ON_TAKEOVER.has(message.processingStatus)) {
		patch['draftResponse'] = undefined;
		patch['draftSubject'] = undefined;
	}
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
		effects.push({
			kind: 'set_thread_draft_status',
			threadId: message.threadId,
			draftStatus: 'pending',
		});
	}
	return { patch, effects };
}

function reduceAwaitingClarification(
	message: Doc<'inboundMessages'>,
	input: InputFor<'awaiting_clarification'>
): TransitionParts {
	const patch: Record<string, unknown> = {};
	const effects: Effect[] = [];
	if (input.completedActionId) {
		effects.push(
			completeAction(input.completedActionId, input.output, {
				durationMs: input.durationMs,
				modelUsed: input.modelUsed,
				tokenUsage: input.tokenUsage,
			})
		);
	}
	// Persist the open questions + classification (so the resume path can
	// reconstruct the draft input). No draft exists yet — thread draft status is
	// left untouched; no knowledge-extraction / code-task effects fire here (they
	// run on the classifying → drafting edge the resume will take).
	if (input.pendingClarification) patch['pendingClarification'] = input.pendingClarification;
	if (input.classification) {
		patch['classification'] = input.classification;
		patch['confidenceScore'] = input.classification.confidence;
	}
	// The agent is now waiting on a person. Tell that person (assignee, else
	// every shared-inbox reader) instead of relying on them to notice the row
	// in the review queue.
	effects.push({ kind: 'notify_clarification', inboundMessageId: message._id });
	return { patch, effects };
}

function reduceInformational(
	message: Doc<'inboundMessages'>,
	input: InputFor<'informational'>
): TransitionParts {
	const patch: Record<string, unknown> = {};
	const effects: Effect[] = [];
	if (input.completedActionId) {
		effects.push(
			completeAction(input.completedActionId, input.output, {
				durationMs: input.durationMs,
				modelUsed: input.modelUsed,
				tokenUsage: input.tokenUsage,
			})
		);
	}
	if (input.classification) {
		patch['classification'] = input.classification;
		patch['confidenceScore'] = input.classification.confidence;
	}
	// An update we never reply to is still knowledge (a supplier's new terms, a
	// customer's org change). Mine it exactly like the drafting edge does.
	effects.push({ kind: 'schedule_knowledge_extraction', inboundMessageId: message._id });
	return { patch, effects };
}

function reduceQuarantined(
	_message: Doc<'inboundMessages'>,
	input: InputFor<'quarantined'>
): TransitionParts {
	const effects: Effect[] = [];
	if (input.completedActionId) {
		effects.push(
			completeAction(input.completedActionId, input.output, { durationMs: input.durationMs })
		);
	}
	return { patch: { securityFlags: input.securityFlags }, effects };
}

function reduceArchived(
	_message: Doc<'inboundMessages'>,
	input: InputFor<'archived'>
): TransitionParts {
	const patch: Record<string, unknown> = {};
	const effects: Effect[] = [];
	if (input.completedActionId) {
		effects.push(
			completeAction(input.completedActionId, input.output, { durationMs: input.durationMs })
		);
	}
	if (input.securityFlags) patch['securityFlags'] = input.securityFlags;
	patch['archiveReason'] = input.reason;
	return { patch, effects };
}

function reduceApproved(
	message: Doc<'inboundMessages'>,
	input: InputFor<'approved'>
): TransitionParts {
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
		// The human-approve undo window rides along per call (approveDraft
		// resolves it from agentConfig); the autonomous window stays resolved
		// inside the effect runner, so the auto path is untouched by this field.
		...(input.source === 'human' && input.undoDelayMs !== undefined
			? { delayMs: input.undoDelayMs }
			: {}),
	});
	if (input.source === 'auto') {
		effects.push({ kind: 'increment_auto_reply_count' });
	}
	if (message.threadId) {
		effects.push({
			kind: 'set_thread_draft_status',
			threadId: message.threadId,
			draftStatus: 'approved',
		});
	}
	// Persist the approval's provenance: the send-time feedback recorder keys
	// on it, and the reconcile cron re-fires `sendApprovedReply` without the
	// `autonomous` arg — the message itself must carry the truth.
	return { patch: { approvalSource: input.source }, effects };
}

function reduceThreadStatusOnly(
	message: Doc<'inboundMessages'>,
	draftStatus: 'sent' | 'rejected'
): TransitionParts {
	const effects: Effect[] = [];
	if (message.threadId) {
		effects.push({ kind: 'set_thread_draft_status', threadId: message.threadId, draftStatus });
	}
	return { patch: {}, effects };
}

function reduceReceived(
	message: Doc<'inboundMessages'>,
	input: InputFor<'received'>
): TransitionParts {
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

function reduceFailed(
	_message: Doc<'inboundMessages'>,
	input: InputFor<'failed'>
): TransitionParts {
	const patch: Record<string, unknown> = { errorMessage: input.errorMessage };
	const effects: Effect[] = [];
	if (input.failingActionId) {
		effects.push({
			kind: 'fail_action',
			actionId: input.failingActionId,
			errorMessage: input.errorMessage,
		});
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
		case 'awaiting_clarification':
			return reduceAwaitingClarification(message, input);
		case 'informational':
			return reduceInformational(message, input);
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
	'informational',
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
