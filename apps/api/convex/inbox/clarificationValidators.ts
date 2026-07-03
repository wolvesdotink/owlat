/**
 * Clarification-loop validators (inboundMessages.pendingClarification).
 *
 * Split out of `lib/convexValidators.ts` to keep that shared module under the
 * ~500 LOC file-size ratchet (CONVENTIONS.md — split into domain siblings, not
 * baseline). Co-located with the clarification mutation (`./clarification.ts`)
 * and consumed by `schema/inbox.ts` and `processingLifecycle/types.ts`.
 *
 * FOUNDATION for the clarification loop. When the (future) clarify step decides
 * the agent is missing a fact it needs before it can safely draft, it parks the
 * message in the `awaiting_clarification` processing state and records the open
 * questions here. The owner answers them from the review surface
 * (`inbox.answerClarification`), which folds each answer back in as a TRUSTED
 * `[CONFIRMED BY OWNER]` block and resumes the draft. `answer` is absent until
 * the question is answered; `source` records whether the value came from the
 * owner ("user") or was auto-filled from stored memory ("memory"). No question
 * GENERATION happens in this piece — a later piece emits into this shape.
 */

import { v } from 'convex/values';

export const clarificationQuestionValidator = v.object({
	// Stable id used to match an incoming answer back to its question.
	id: v.string(),
	// The kind of missing fact (e.g. "order_number", "date", "free_text"). A
	// free-form slot label — the resolver/UI interprets it. Advisory.
	slotType: v.string(),
	// Human-readable question shown to the owner.
	text: v.string(),
	// Optional suggested answers (for a multiple-choice slot).
	options: v.optional(v.array(v.string())),
	// The resolved answer — absent until answered.
	answer: v.optional(
		v.object({
			value: v.string(),
			source: v.union(v.literal('user'), v.literal('memory')),
			at: v.number(),
		}),
	),
});

export const pendingClarificationValidator = v.object({
	questions: v.array(clarificationQuestionValidator),
	// When the questions were surfaced to the owner. Drives the abandoned-question
	// fallback: after a configurable window with no answer, the pipeline resumes
	// the draft as a flagged best-guess that is never auto-send-eligible.
	askedAt: v.number(),
	// When the owner answered — set by `answerClarification`. Absent while pending.
	answeredAt: v.optional(v.number()),
});
