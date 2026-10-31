/**
 * The read side of "no team draft with silent gaps": an agent draft
 * with `[[...]]` gaps nobody agreed to is not shown, however it was stored.
 *
 * The draft step and the write-side fence (`inbox/stepOutputs.recordDraftOutput`)
 * keep new ones from being stored. Rows stored before that rule still carry
 * them, and every read of a row that leaves for a client goes through
 * `messageBodyInbound.openInboundMessageRow`, which applies
 * {@link withHeldGapDraft}: the draft goes, and the row says why, so the
 * review surfaces show a message waiting for a person to write the reply.
 *
 * Kept: a draft the owner agreed to ("Draft with what I have", or asking
 * turned off when it was written: `isDraftGapsAccepted`), a person's own text
 * (a takeover or a saved edit), and the reply of an approved or sent message,
 * which is what went out. Pure (no ctx, no 'use node').
 */

import { authoredDraftHasGaps } from '../agent/shared/draftGaps';

/** Why a reply has no AI draft: only a credential could fill its gaps. */
export const UNASKABLE_GAP_REASON =
	'This reply needs a detail Owlat never asks for, such as a password, so there is no AI draft. Write it yourself.';

/** Why an agent draft stored with gaps nobody agreed to is not shown. */
export const HELD_GAP_DRAFT_REASON =
	'The AI draft left details open that nobody was asked about, so it is not shown. Write the reply yourself.';

/** The `inboundMessages` fields the rule reads. */
export interface HeldGapDraftFields {
	processingStatus?: string;
	draftResponse?: string | null;
	draftOptions?: string[] | null;
	isDraftGapGuarded?: boolean;
	isDraftGapsAccepted?: boolean;
	pendingClarification?: { isGapsAccepted?: boolean | undefined } | null;
	draftSavedAt?: number;
	isDraftEdited?: boolean;
	manualTakeoverAt?: number;
	confidenceScore?: number;
	agentDecision?: {
		decision: 'auto_approve' | 'human_review';
		reason: string;
		confidence: number;
	};
}

/** Statuses whose stored draft is the reply that already went out (or is going). */
const OUTGOING_STATUSES = new Set(['approved', 'sent']);

/** Whether a row's draft is an agent draft with gaps nobody agreed to. */
export function isHeldGapDraft(row: HeldGapDraftFields): boolean {
	const draft = row.draftResponse;
	if (!draft || !authoredDraftHasGaps({ text: draft })) return false;
	if (row.processingStatus && OUTGOING_STATUSES.has(row.processingStatus)) return false;
	if (row.isDraftGapsAccepted === true || row.pendingClarification?.isGapsAccepted === true) {
		return false;
	}
	// A person's own text: they took the reply over, or saved an edit.
	if (row.manualTakeoverAt !== undefined || row.draftSavedAt !== undefined) return false;
	return row.isDraftEdited !== true;
}

/**
 * `row` without a held draft, and with the reason a reviewer reads. The
 * variants a legacy row keeps beside the draft go with it: the first of them
 * is the held draft itself.
 */
export function withHeldGapDraft<T extends HeldGapDraftFields>(row: T): T {
	if (!isHeldGapDraft(row)) return row;
	const { draftResponse: _held, draftOptions: _variants, isDraftGapGuarded: _guard, ...rest } = row;
	return {
		...rest,
		agentDecision: {
			decision: 'human_review',
			reason: HELD_GAP_DRAFT_REASON,
			confidence: row.agentDecision?.confidence ?? row.confidenceScore ?? 0,
		},
	} as T;
}
