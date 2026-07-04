/**
 * Shared attachment-suggestion orchestration for the inbound agent pipeline.
 *
 * Wraps the pure matcher (`./attachmentMatch.ts`) around the contact-scoped file
 * search (`semanticFileProcessing.semanticSearch`) so BOTH the `draft` step (which
 * surfaces the single confident suggestion on the review draft) and the `clarify`
 * step (which asks when the choice is ambiguous) run identical, fail-soft logic.
 *
 * Contact scoping is the data-isolation gate: a reply for contact A must never
 * propose contact B's uploaded file. We pass the inbound's resolved `contactId`,
 * falling back to `org-general-only` when there is none (fail closed — never
 * org-wide on the drafting path), exactly like the draft step's recall tool.
 *
 * FAIL-SOFT: every failure (no match, search error, missing ctx) resolves to
 * `null` — the caller then behaves exactly as today (no suggestion, no ask). The
 * autonomous send path never consumes any of this.
 */

import type { Infer } from 'convex/values';
import { internal } from '../_generated/api';
import type { ActionCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { attachmentSuggestionsValidator } from './attachmentValidators';
import {
	detectAttachmentRequest,
	pickAttachmentSuggestion,
	MAX_CANDIDATES,
} from './attachmentMatch';

export type AttachmentSuggestions = Infer<typeof attachmentSuggestionsValidator>;
type PersistedCandidate = AttachmentSuggestions['candidates'][number];

/** Minimal ctx surface needed — satisfied by any agent step's execute ctx. */
type SuggestCtx = Pick<ActionCtx, 'runAction'>;

/** Cap on how much inbound text seeds the search when no tight object phrase was
 * extracted — enough to ground on, bounded so we never embed a whole thread. */
const MAX_QUERY_CHARS = 400;

/**
 * Compute an attachment suggestion for an inbound message, or `null` when the
 * inbound isn't asking for a file / nothing matched / anything failed. Pure of
 * side effects (read-only) — the caller decides whether to persist it (draft) or
 * turn an ambiguous result into a question (clarify).
 */
export async function computeAttachmentSuggestions(
	ctx: SuggestCtx,
	args: { context: string; contactId?: Id<'contacts'> | undefined }
): Promise<AttachmentSuggestions | null> {
	try {
		const { requested, query } = detectAttachmentRequest(args.context);
		if (!requested) return null;

		const queryText = (query.length > 0 ? query : args.context).slice(0, MAX_QUERY_CHARS).trim();
		if (queryText.length === 0) return null;

		const scopeToContact: Id<'contacts'> | 'org-general-only' =
			args.contactId ?? 'org-general-only';

		const files = await ctx.runAction(internal.semanticFileProcessing.semanticSearch, {
			queryText,
			scopeToContact,
			limit: MAX_CANDIDATES + 2,
		});
		if (files.length === 0) return null;

		const candidates: PersistedCandidate[] = files.map((file) => ({
			fileId: file._id,
			storageId: file.storageId,
			filename: file.filename,
			...(file.title ? { title: file.title } : {}),
			mimeType: file.mimeType,
			fileSize: file.fileSize,
			score: file._score,
		}));

		const picked = pickAttachmentSuggestion(candidates);
		if (picked.candidates.length === 0) return null;

		return { query, ambiguous: picked.ambiguous, candidates: picked.candidates };
	} catch {
		// Fail-soft: no suggestion, no ask — today's behaviour.
		return null;
	}
}
