/**
 * Inbox processing lifecycle — who may move a message to `draft_ready`, and
 * which writes stand down once a person has taken the reply over
 * (inbox/manualReply.ts). Pure; split out of `./reducers.ts` to hold it under
 * the size cap.
 */

import type { ProcessingStatus, TransitionInput } from './types';

/**
 * States only a person may move to `draft_ready` (with `manualTakeover`): the
 * closed ones, `received`, which the pipeline would otherwise leave through
 * `security_check`, and `awaiting_clarification`, which the agent leaves
 * through `drafting`.
 */
const TAKEOVER_ONLY_SOURCES: ReadonlySet<ProcessingStatus> = new Set([
	'received',
	'awaiting_clarification',
	'rejected',
	'archived',
]);

/** Closed states whose leftover draft a manual takeover discards. */
export const CLEARS_DRAFT_ON_TAKEOVER: ReadonlySet<ProcessingStatus> = new Set([
	'rejected',
	'archived',
]);

export function requiresManualTakeover(from: ProcessingStatus, to: ProcessingStatus): boolean {
	return to === 'draft_ready' && TAKEOVER_ONLY_SOURCES.has(from);
}

/**
 * Does this input come from the agent pipeline? Walker and hosted steps carry
 * the agent action they complete or fail, and only the router auto-approves.
 * Once a person has taken the reply over (`manualTakeoverAt`), these stand
 * down: a draft finishing, the router auto-sending, or a step failing must not
 * overwrite, send over or fail the person's reply.
 */
export function isPipelineInput(input: TransitionInput): boolean {
	if (input.to === 'approved' && input.source === 'auto') return true;
	return (
		('completedActionId' in input && input.completedActionId !== undefined) ||
		('failingActionId' in input && input.failingActionId !== undefined)
	);
}
