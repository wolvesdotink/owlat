/**
 * Clarification-loop validators (inboundMessages.pendingClarification).
 *
 * Split out of `lib/convexValidators.ts` to keep that shared module under the
 * ~500 LOC file-size ratchet (CONVENTIONS.md — split into domain siblings, not
 * baseline). Co-located with the clarification mutation (`./clarification.ts`)
 * and consumed by `schema/inbox.ts` and `processingLifecycle/types.ts`. The
 * Reply Queue's own clarification shape (`needsReplyClarificationValidator`,
 * at the bottom) lives here too and feeds `schema/mailThreads.ts` and
 * `mail/needsReply.ts`.
 *
 * FOUNDATION for the clarification loop. When the (future) clarify step decides
 * the agent is missing a fact it needs before it can safely draft, it parks the
 * message in the `awaiting_clarification` processing state and records the open
 * questions here. The owner answers them from the review surface
 * (`inbox.answerClarification`), which folds each answer back in as a TRUSTED
 * `[CONFIRMED BY OWNER]` block and resumes the draft. `answer` is absent until
 * the question is answered; `source` records whether the value came from the
 * owner ("user") or was auto-filled from stored memory ("memory"). No question
 * GENERATION happens here — the generator emits into this shape.
 */

import { v } from 'convex/values';

/**
 * One translation of a question (text + option chips) into an interface
 * locale. The canonical `text` / `options` are English; the UI renders the
 * entry matching the reader's locale and falls back to the canonical copy.
 */
export const clarificationTranslationValidator = v.object({
	locale: v.string(),
	text: v.string(),
	options: v.optional(v.array(v.string())),
});

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
	// Per-locale renderings of `text` + `options`; see
	// clarificationTranslationValidator. Absent when localization failed.
	translations: v.optional(v.array(clarificationTranslationValidator)),
	// The resolved answer — absent until answered.
	answer: v.optional(
		v.object({
			value: v.string(),
			source: v.union(v.literal('user'), v.literal('memory')),
			at: v.number(),
		})
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

/**
 * One Reply Queue clarification question (`mailThreads.needsReply.clarification`).
 * The Postbox-native loop: a sibling of `clarificationQuestionValidator` above,
 * which serves the inbound agent's `pendingClarification` instead. Differs in
 * `attribution` (always present) and an answer that carries no `source`.
 */
export const needsReplyClarificationQuestionValidator = v.object({
	// Stable id matching an incoming answer back to its question.
	id: v.string(),
	// The reply-slot kind (shared taxonomy, inbox/clarificationSlots.ts).
	slotType: v.string(),
	// The question shown to the owner.
	text: v.string(),
	// Provenance + "Owlat will never ask for your password" promise.
	attribution: v.string(),
	// Suggested scoped answers rendered as one-tap chips (multiple
	// choice); absent for a free-text-only slot.
	options: v.optional(v.array(v.string())),
	// Per-locale renderings of text + options (see
	// clarificationTranslationValidator). Absent when localization
	// failed; the card then shows the canonical English copy.
	translations: v.optional(v.array(clarificationTranslationValidator)),
	// The owner's answer — absent until answered.
	answer: v.optional(
		v.object({
			value: v.string(),
			at: v.number(),
		})
	),
});

/**
 * Clarification loop (Postbox-native): set when the refinement pass
 * decides a good reply needs a fact only the owner can supply and the
 * capable-tier divergence confirmation agrees it is genuinely open.
 * Flips the Reply Queue row from "Needs you" to "Needs your input".
 * LLM-refined only; every question is deterministically sanitized
 * (credential/OTP solicitations dropped) and attributed to the sender
 * in mail/ai/needsReplyClassify.ts before it is persisted.
 *
 * The single source of truth for both the `mailThreads.needsReply` schema
 * field (schema/mailThreads.ts) and the `mail.needsReply.applyResult`
 * argument, so the two can no longer drift apart.
 */
export const needsReplyClarificationValidator = v.object({
	// True while at least one question is still awaiting an answer.
	isNeeded: v.boolean(),
	questions: v.array(needsReplyClarificationQuestionValidator),
	// When the questions were surfaced (advisory ordering only).
	askedAt: v.number(),
	// Set once the owner answers — drives the draftWithAnswers path.
	answeredAt: v.optional(v.number()),
	// The starter reply produced by draftWithAnswers once the owner
	// answered. Its presence flips the card to "Draft ready".
	draft: v.optional(v.string()),
});
