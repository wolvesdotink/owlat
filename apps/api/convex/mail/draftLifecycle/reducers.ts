/**
 * Mail draft lifecycle — legal-edge graph + pure reducers.
 *
 * Reducers do not touch the DB or the scheduler. They return the patch +
 * effect list; the runner in `./effects.ts` applies the patch first, then
 * dispatches effects. Validation that depends on freshly-read DB state (e.g.
 * the from-address allow-set re-check inside `→ sent`) happens in the
 * dispatcher BEFORE the reducer fires.
 *
 * See docs/adr/0028-mail-draft-lifecycle-module.md.
 */

import type { Doc } from '../../_generated/dataModel';
import { defineLifecycle } from '../../lib/lifecycle';
import {
	DEFAULT_UNDO_SEND_DELAY_MS,
	type AuditLogEffect,
	type DraftState,
	type Effect,
	type ReducerResult,
	type RevertReason,
	type TransitionInput,
} from './types';

// ─── Legal-edges graph ──────────────────────────────────────────────────────
//
// The graph lives in the generic lifecycle core (`lib/lifecycle.ts`, ADR-0058);
// the reducers, preconditions and effects stay in this module family. From-states
// and to-states are separately parameterized because `sent` is a target only —
// the row is deleted on arrival, so `sent` is never persisted back as a draft
// state and never appears as a from-state.
//
// Unlike every other migrated machine this dispatcher asks the graph
// `isLegalEdge` rather than `classify`: it has never granted the implicit
// self-loop pass, and `draft → draft` must keep refusing as `illegal_edge`
// (ADR-0028 routes the undo double-fire through `transitionByUndoToken`'s
// `already_draft` / `recorded` path, not through a reducer self-loop).
// `reportsTerminalRefusals` is therefore moot and stays off — the published
// outcome union carries `illegal_edge` and no `terminal` arm.

export const DRAFT_LIFECYCLE = defineLifecycle<DraftState, TransitionInput['to']>({
	draft: ['pending_send', 'scheduled'],
	pending_send: ['draft', 'sent'],
	scheduled: ['draft', 'sent'],
});

// ─── State-guard helper ─────────────────────────────────────────────────────

/**
 * Centralized state-precondition assertion. Replaces six open-coded
 * `state !== 'X'` checks scattered across mail/drafts.ts and the old
 * outboundQueries.ts. Throws so the call site keeps its `throw new Error(...)`
 * surface — callers that want a soft outcome should use `transition` instead.
 */
export function assertStateIs(draft: Doc<'mailDrafts'>, state: DraftState): void {
	if (draft.state !== state) {
		throw new Error(`Draft state is ${draft.state}, expected ${state}`);
	}
}

// ─── Recipient helper ───────────────────────────────────────────────────────

/**
 * Lower-cased, de-duplicated union of a draft's to/cc/bcc addresses. The same
 * recipient set feeds the address-book record, the audit-log recipientCount,
 * and the new mailMessages row's outbound.recipients[].
 */
export function dedupedRecipients(draft: Doc<'mailDrafts'>): string[] {
	return [
		...draft.toAddresses.map((s) => s.toLowerCase()),
		...draft.ccAddresses.map((s) => s.toLowerCase()),
		...draft.bccAddresses.map((s) => s.toLowerCase()),
	].filter((addr, i, arr) => arr.indexOf(addr) === i);
}

// ─── Reducers ───────────────────────────────────────────────────────────────

function generateUndoToken(at: number): string {
	return `und_${at.toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function reducePendingSend(
	draft: Doc<'mailDrafts'>,
	args: Extract<TransitionInput, { to: 'pending_send' }>
): ReducerResult {
	const delay = Math.max(0, args.undoSendDelayMs ?? DEFAULT_UNDO_SEND_DELAY_MS);
	const sendAt = args.at + delay;
	const undoToken = generateUndoToken(args.at);
	return {
		patch: {
			state: 'pending_send',
			scheduledSendAt: sendAt,
			undoToken,
			lastEditedAt: args.at,
		},
		effects: [
			{
				kind: 'schedule_dispatch_action',
				draftId: draft._id,
				undoToken,
				sendAt,
			},
			{
				kind: 'audit_log',
				action: 'postbox_draft.send_initiated',
				draftId: draft._id,
				mailboxId: draft.mailboxId,
				details: {
					sendAt,
					undoSendDelayMs: delay,
					mode: 'pending_send',
				},
			},
		],
		applied: 'transitioned',
		extras: { undoToken, sendAt },
	};
}

export function reduceScheduled(
	draft: Doc<'mailDrafts'>,
	args: Extract<TransitionInput, { to: 'scheduled' }>
): ReducerResult {
	const undoToken = generateUndoToken(args.at);
	return {
		patch: {
			state: 'scheduled',
			scheduledSendAt: args.scheduledSendAt,
			undoToken,
			lastEditedAt: args.at,
		},
		effects: [
			{
				kind: 'schedule_dispatch_action',
				draftId: draft._id,
				undoToken,
				sendAt: args.scheduledSendAt,
			},
			{
				kind: 'audit_log',
				action: 'postbox_draft.send_initiated',
				draftId: draft._id,
				mailboxId: draft.mailboxId,
				details: {
					sendAt: args.scheduledSendAt,
					mode: 'scheduled',
				},
			},
		],
		applied: 'transitioned',
		extras: { undoToken, sendAt: args.scheduledSendAt },
	};
}

const REVERT_AUDIT_ACTION: Record<RevertReason, AuditLogEffect['action']> = {
	user_cancel: 'postbox_draft.cancelled',
	from_revoked: 'postbox_draft.from_revoked',
	scan_blocked: 'postbox_draft.scan_blocked',
	seal_consent_required: 'postbox_draft.seal_consent_required',
};

export function reduceDraftRevert(
	draft: Doc<'mailDrafts'>,
	args: Extract<TransitionInput, { to: 'draft' }>
): ReducerResult {
	return {
		patch: {
			state: 'draft',
			scheduledSendAt: undefined,
			undoToken: undefined,
			isUnsealedSendAllowed: undefined,
			lastEditedAt: args.at,
		},
		effects: [
			{
				kind: 'audit_log',
				action: REVERT_AUDIT_ACTION[args.reason],
				draftId: draft._id,
				mailboxId: draft.mailboxId,
				details: {
					reason: args.reason,
					fromState: draft.state,
				},
			},
		],
		applied: 'transitioned',
	};
}

export function reduceSent(
	draft: Doc<'mailDrafts'>,
	args: Extract<TransitionInput, { to: 'sent' }>
): ReducerResult {
	const recipients = dedupedRecipients(draft);

	// Edit-learning flywheel: only when this draft was AI-authored (has a
	// baseline) AND the user actually changed something before sending. The diff
	// itself + recurrence gating happen out of band in mail/ai/editLearning.ts.
	const baselineText = draft.aiDraftBaseline?.text?.trim() ?? '';
	// `||` (not `??`) so a present-but-empty bodyText falls through to bodyHtml.
	const sentText = (args.context.bodyText || args.context.bodyHtml).trim();
	const learningEffects: Effect[] =
		baselineText.length > 0 && sentText.length > 0
			? [
					{
						kind: 'schedule_edit_learning',
						mailboxId: draft.mailboxId,
						...(recipients[0] !== undefined ? { contactAddress: recipients[0] } : {}),
						baselineText,
						sentText,
					},
				]
			: [];

	return {
		// The `→ sent` reducer carries no draft patch — the runner deletes
		// the row instead. The patch is empty so the runner skips
		// ctx.db.patch.
		patch: {},
		effects: [
			// Storage cleanup runs ALONGSIDE the row delete so a crash leaves
			// no orphaned blobs.
			{
				kind: 'delete_attachment_storage',
				storageIds: draft.attachments.map((a) => a.storageId),
			},
			{
				kind: 'record_recipients_in_address_book',
				mailboxId: draft.mailboxId,
				emails: recipients,
			},
			...learningEffects,
			// The audit log fires AFTER the new mailMessages row insert so
			// `messageId` is available — the runner enriches the details
			// after insertion.
			{
				kind: 'audit_log',
				action: 'postbox_draft.sent',
				draftId: draft._id,
				mailboxId: draft.mailboxId,
				details: {
					rawSize: args.context.rawSize,
					recipientCount: recipients.length,
				},
			},
		],
		applied: 'transitioned',
		extras: { sentContext: args.context },
	};
}
