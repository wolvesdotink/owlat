/**
 * Attachment-suggestion validator (inboundMessages.attachmentSuggestions).
 *
 * Co-located with the pure matcher (`./attachmentMatch.ts`) and consumed by
 * `schema/inbox.ts` and `inbox/stepOutputs.ts`. Read-side advisory metadata the
 * `draft` step persists when the inbound asks for a document and a contact-scoped
 * `semanticFiles` match exists: the review gate + composer render it as a
 * one-tap "attach <file>?" chip. It is NEVER consumed by the autonomous send
 * path — attachment suggestions are human-confirmed only (recipient-lock forbids
 * a new attachment on an unattended reply). Absent when nothing matched.
 */

import { v } from 'convex/values';

/** One proposed file, carrying enough to render the chip AND to hand straight to
 * the composer's `mail.drafts.addAttachment` (storageId + filename + type + size)
 * when the human taps it. */
export const attachmentCandidateValidator = v.object({
	fileId: v.id('semanticFiles'),
	storageId: v.id('_storage'),
	filename: v.string(),
	title: v.optional(v.string()),
	mimeType: v.string(),
	fileSize: v.number(),
	// Advisory fusion score from the file search (best first).
	score: v.number(),
});

export const attachmentSuggestionsValidator = v.object({
	// The rough object phrase the search was seeded with (observability / UI hint).
	query: v.string(),
	// True when the choice was genuinely ambiguous — the clarify step asks the
	// owner to pick rather than guessing. The review gate then shows the shortlist
	// as a pick-one instead of a single one-tap.
	ambiguous: v.boolean(),
	// One entry when confident; the shortlist when ambiguous. Capped upstream.
	candidates: v.array(attachmentCandidateValidator),
});
