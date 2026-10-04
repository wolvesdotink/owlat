/**
 * Non-destructive draft revisions.
 *
 * A human save on the review surface APPENDS to `draftRevisions[]` instead of
 * overwriting the agent's text: the first save seeds revision 0 with the agent
 * original (`savedBy: 'agent'`, immutable thereafter), every later save appends
 * one entry, and `draftSavedAt` is stamped so the queue can render the
 * "Saved · edited by you" chip. The row stays `draft_ready` — saving is not a
 * status transition (except a save while the agent can still draft over it,
 * which takes the reply over first, see `manualReply.takeOverForHumanSave`)
 * and records NO autonomy feedback; the `'edited'` signal
 * fires once at approve time, iff the sent text differs from revision 0 (see
 * `decisionFeedback.recordApprovalSignals`).
 *
 * A sibling of `mutations.ts` rather than more lines in it: that file already
 * sits at the ~500 LOC split threshold (CONVENTIONS.md).
 */

import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { adminMutation } from '../lib/authedFunctions';
import { recordAuditLog } from '../lib/auditLog';
import { getOrThrow } from '../_utils/errors';
import { authoredDraftHasGaps } from '../agent/shared/draftGaps';
import { isStoredVariant } from '../lib/draftVariants';
import { takeOverForHumanSave } from './manualReply';

/** `savedBy` marker for the seeded revision-0 agent original. */
const AGENT_REVISION_AUTHOR = 'agent';

/**
 * True when the CURRENT draft text differs (trim-insensitively) from the
 * agent's original as preserved in revision 0. The approve-time `'edited'`
 * autonomy signal keys off this, so a draft edited and then reverted back to
 * the agent's exact text honestly counts as unedited. Messages with no
 * revision history (never saved, or a human-composed reply to a draftless
 * escalation) never count as edited-from-agent-original.
 */
export function draftDiffersFromAgentOriginal(message: Doc<'inboundMessages'>): boolean {
	const original = message.draftRevisions?.[0];
	if (!original || original.savedBy !== AGENT_REVISION_AUTHOR) return false;
	return (message.draftResponse ?? '').trim() !== original.text.trim();
}

/**
 * Append one human draft revision and make it the working draft.
 *
 * Shared by `saveDraftRevision` (the inline Save) and `mutations.editDraft`
 * (inline edits, the AiReviseBox apply, compose-for-draftless) so every write
 * path preserves the agent original instead of destroying it. Seeds revision 0
 * from the agent's current draft on first save — only when an agent draft
 * actually exists, so a human-composed reply to a draftless escalation has no
 * fake "agent original". A save whose text matches the latest revision skips
 * the duplicate append but still stamps `draftSavedAt` and patches the
 * subject. Records NO autonomy feedback.
 *
 * Any agent variants (`draftOptions`) are dropped: they were offered against
 * the agent's draft, and this save replaces it. A saved text that IS one of
 * them is stored gap-guarded when it holds a `[[...]]` gap.
 *
 * `gapGuarded` is the composer's saved-reply gap guard for this text
 * (`isDraftGapGuarded`): stored with it, so its `[[...]]` gaps still hold Send
 * after a reload and `approveDraft` refuses them. Omitted = left as it was.
 *
 * A save while the agent can still write its draft over this one (`drafting`,
 * `awaiting_clarification`) takes the reply over first, so the late agent
 * draft cannot replace the saved text or clear its revisions (#1221).
 */
export async function appendDraftRevision(
	ctx: MutationCtx,
	message: Doc<'inboundMessages'>,
	args: { text: string; subject?: string; savedBy: string; gapGuarded?: boolean }
): Promise<void> {
	// Only `processingStatus` (and the takeover fields) change here; the draft
	// fields read from `message` below are untouched by it.
	await takeOverForHumanSave(ctx, message, args.savedBy);

	const now = Date.now();
	const revisions = [...(message.draftRevisions ?? [])];

	// First save: preserve the agent original as immutable revision 0.
	const agentOriginal = message.draftResponse?.trim();
	if (revisions.length === 0 && agentOriginal) {
		revisions.push({
			text: message.draftResponse!,
			...(message.draftSubject !== undefined ? { subject: message.draftSubject } : {}),
			savedAt: message.processedAt ?? message.receivedAt,
			savedBy: AGENT_REVISION_AUTHOR,
		});
	}

	// Saving one of the agent's variants (picked, or copied) saves agent text,
	// so its `[[...]]` gaps hold the send as the agent's draft's do. A person's
	// own typed brackets keep whatever guard the client sent.
	const variantGapped =
		isStoredVariant(message, args.text) && authoredDraftHasGaps({ text: args.text });
	const gapGuarded = variantGapped || args.gapGuarded;

	const effectiveSubject = args.subject ?? message.draftSubject;
	const latest = revisions[revisions.length - 1];
	if (latest?.text.trim() !== args.text.trim()) {
		revisions.push({
			text: args.text,
			...(effectiveSubject !== undefined ? { subject: effectiveSubject } : {}),
			savedAt: now,
			savedBy: args.savedBy,
		});
	}

	await ctx.db.patch(message._id, {
		draftResponse: args.text,
		...(args.subject !== undefined ? { draftSubject: args.subject } : {}),
		draftRevisions: revisions,
		draftSavedAt: now,
		...(gapGuarded !== undefined ? { isDraftGapGuarded: gapGuarded } : {}),
		// The agent's variants were alternatives to the agent's draft. Once a
		// person writes the working draft they describe a text nobody sees.
		draftOptions: undefined,
		// Kept as the honest differs-from-agent-original bit so the existing
		// `clarification_unedited_send` outcome discrimination stays accurate:
		// a save reverting to the agent's exact text counts as unedited.
		isDraftEdited:
			revisions[0]?.savedBy === AGENT_REVISION_AUTHOR &&
			args.text.trim() !== revisions[0].text.trim(),
	});
}

/**
 * Save the reviewer's working draft WITHOUT approving it (the inline "Save"
 * beside "Save & Approve"). Appends a revision, stamps `draftSavedAt`, leaves
 * the row in `draft_ready`, and deliberately records NO autonomy feedback —
 * saving progress is not a verdict on the agent's draft; the `'edited'` signal
 * fires once at approve time iff the sent text differs from the agent original.
 */
export const saveDraftRevision = adminMutation({
	args: {
		inboundMessageId: v.id('inboundMessages'),
		draftResponse: v.string(),
		draftSubject: v.optional(v.string()),
		// The composer's saved-reply gap guard (see `appendDraftRevision`).
		isGapGuarded: v.optional(v.boolean()),
	},
	handler: async (ctx, args, session) => {
		const message = await getOrThrow(ctx, args.inboundMessageId, 'Message');

		await appendDraftRevision(ctx, message, {
			text: args.draftResponse,
			...(args.draftSubject !== undefined ? { subject: args.draftSubject } : {}),
			savedBy: session.userId,
			gapGuarded: args.isGapGuarded,
		});

		await recordAuditLog(ctx, {
			userId: session.userId,
			action: 'inbound.draft_saved',
			resource: 'inbound_message',
			resourceId: args.inboundMessageId,
		});

		return { success: true };
	},
});
