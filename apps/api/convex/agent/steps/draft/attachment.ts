'use node';

/**
 * Attachment-suggestion helper for the `draft` step.
 *
 * Split out of `draft/index.ts` (per CONVENTIONS.md "Split only above ~500 LOC"
 * — do NOT baseline frozen debt) and mirroring the sibling matcher in
 * `inbox/attachmentMatch.ts` / orchestration in `inbox/attachmentSuggest.ts`.
 *
 * When the inbound asks for a document ("can you send X" / "see attached") and a
 * contact-scoped `semanticFiles` match exists, this returns the persist-ready
 * `attachmentSuggestions` field so the review gate can offer a one-tap
 * "attach <file>?". Advisory metadata ONLY: it is never turned into a real
 * attachment on the autonomous send path (recipient-lock forbids a new
 * attachment on an unattended reply) — a human confirms it. FAIL-SOFT: any
 * failure resolves to `{}` (no suggestion), exactly today's behaviour.
 */

import type { ActionCtx } from '../../../_generated/server';
import type { Id } from '../../../_generated/dataModel';
import {
	computeAttachmentSuggestions,
	type AttachmentSuggestions,
} from '../../../inbox/attachmentSuggest';

/** Minimal ctx surface — satisfied by the `draft` step's execute ctx. */
type DraftAttachmentCtx = Pick<ActionCtx, 'runAction'>;

/**
 * Compute the persist-ready attachment-suggestion patch for `recordDraftOutput`.
 * Returns `{ attachmentSuggestions }` on a match, else `{}` so the caller can
 * spread it unconditionally. Never throws.
 */
export async function draftAttachmentPatch(
	ctx: DraftAttachmentCtx,
	context: string,
	contactId: Id<'contacts'> | undefined
): Promise<{ attachmentSuggestions: AttachmentSuggestions } | Record<string, never>> {
	const suggestions = await computeAttachmentSuggestions(ctx, { context, contactId });
	return suggestions ? { attachmentSuggestions: suggestions } : {};
}
