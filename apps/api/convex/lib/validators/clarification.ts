/**
 * Clarification-loop validators (inboundMessages.pendingClarification).
 *
 * The clarification mutation is `inbox/clarification.ts`; this shape is
 * consumed by `schema/inbox.ts` and `inbox/processingLifecycle/types.ts`. The
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
import { ASK_ANSWER_KINDS, ASK_FILE_SOURCES } from '@owlat/shared/answerMode';
import { literalUnion } from '../literalUnion';

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

/**
 * How a question is answered (`@owlat/shared/answerMode` ASK_ANSWER_KINDS).
 * Absent on rows written before Answer mode, which read as `choice` when they
 * carry options and `text` otherwise.
 */
export const clarificationAnswerKindValidator = literalUnion(ASK_ANSWER_KINDS);

/** Where a file answer's bytes live: a fresh upload, a Files row, or a mail attachment. */
export const clarificationFileSourceValidator = literalUnion(ASK_FILE_SOURCES);

/**
 * A file the person picked or uploaded to answer a `file` question. `id` is the
 * storage id for an upload, the `semanticFiles` id or the `mailAttachments` id
 * otherwise; the owning module re-checks access before attaching it.
 */
export const clarificationFileRefValidator = v.object({
	source: clarificationFileSourceValidator,
	id: v.string(),
	filename: v.string(),
});

/**
 * A near match offered with a `file` question ("Close, but maybe not it").
 * Read access was checked when the candidate was computed; attaching re-checks.
 */
export const clarificationFileCandidateValidator = v.object({
	source: v.union(v.literal('semanticFile'), v.literal('mailAttachment')),
	id: v.string(),
	filename: v.string(),
	title: v.optional(v.string()),
	mimeType: v.string(),
	size: v.number(),
	score: v.number(),
	// Why it may not be the one, e.g. "August" for a September request.
	note: v.optional(v.string()),
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
	// How the question is answered; see clarificationAnswerKindValidator.
	answerKind: v.optional(clarificationAnswerKindValidator),
	// Near matches offered with a `file` question.
	fileCandidates: v.optional(v.array(clarificationFileCandidateValidator)),
	// The resolved answer — absent until answered. For a `file` answer, `value`
	// is the filename and `file` points at the bytes.
	answer: v.optional(
		v.object({
			value: v.string(),
			source: v.union(v.literal('user'), v.literal('memory')),
			at: v.number(),
			file: v.optional(clarificationFileRefValidator),
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
 * Where a question came from, for the trust line the web words in the reader's
 * language ("Based on an email from acme.com. Owlat never asks for your
 * password."). `senderDomain` is absent when the sender address has none.
 */
export const clarificationOriginValidator = v.object({
	kind: v.literal('email'),
	senderDomain: v.optional(v.string()),
});

/**
 * One Reply Queue clarification question (`mailThreads.needsReply.clarification`).
 * The Postbox-native loop: a sibling of `clarificationQuestionValidator` above,
 * which serves the inbound agent's `pendingClarification` instead. Differs in
 * its provenance (`origin`) and an answer that carries no `source`.
 */
export const needsReplyClarificationQuestionValidator = v.object({
	// Stable id matching an incoming answer back to its question.
	id: v.string(),
	// The reply-slot kind (shared taxonomy, inbox/clarificationSlots.ts).
	slotType: v.string(),
	// The question shown to the owner.
	text: v.string(),
	// Structured provenance; the web builds the localized trust line, with the
	// "Owlat never asks for your password" promise, from it. Written on every
	// question. Questions stored before it existed carried an English
	// `attribution` sentence instead; migration 0066
	// (backfill_clarification_origin) converted those, and the field is gone
	// from the schema (#1224), so a deployment that still holds one rejects
	// this schema on deploy. Optional because a question with no provenance
	// shows no trust line rather than an invented one.
	origin: v.optional(clarificationOriginValidator),
	// Suggested scoped answers rendered as one-tap chips (multiple
	// choice); absent for a free-text-only slot.
	options: v.optional(v.array(v.string())),
	// Per-locale renderings of text + options (see
	// clarificationTranslationValidator). Absent when localization
	// failed; the card then shows the canonical English copy.
	translations: v.optional(v.array(clarificationTranslationValidator)),
	// How the question is answered; see clarificationAnswerKindValidator.
	answerKind: v.optional(clarificationAnswerKindValidator),
	// Near matches offered with a `file` question.
	fileCandidates: v.optional(v.array(clarificationFileCandidateValidator)),
	// The owner's answer — absent until answered. `source` is absent on rows
	// written before memory answers were shown in the Postbox (read as 'user').
	// A file answer keeps its first file in `file`; `files` lists them all when
	// the owner gave more than one (the invoices for four bookings). Read both
	// through `answerFiles` (inbox/clarificationAnswers.ts).
	answer: v.optional(
		v.object({
			value: v.string(),
			at: v.number(),
			source: v.optional(v.union(v.literal('user'), v.literal('memory'))),
			file: v.optional(clarificationFileRefValidator),
			files: v.optional(v.array(clarificationFileRefValidator)),
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
 * argument (through {@link needsReplyClarificationArgValidator}), so the two
 * can no longer drift apart.
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

/**
 * N-1 SHIM (#1224), remove in 0.6.12. The argument shape of a question for the
 * internal mutations a 0.6.10 action calls with questions it read earlier:
 * `mail.needsReply.applyResult`, and `replaceSession` / `updateSession` in
 * `mail/ai/composeDraftStore.ts`. A 0.6.10 action that read a question before
 * migration 0066 converted it still holds the `attribution` sentence and sends
 * it back after this release is deployed; a strict argument would throw outside
 * the action's recovery and leave its session stuck in `drafting`. So the
 * argument accepts the field and the mutation drops it with
 * {@link withoutLegacyAttribution} before writing. Nothing reads it, and the
 * stored validator above stays strict, so the deploy still refuses a stored
 * question that has it. From 0.6.12 the N-1 release is 0.6.11, which never
 * sends the field: delete these and use the stored validators again.
 */
export const needsReplyClarificationQuestionArgValidator = v.object({
	...needsReplyClarificationQuestionValidator.fields,
	attribution: v.optional(v.string()),
});

/** {@link needsReplyClarificationValidator} as an argument (N-1 shim, #1224). */
export const needsReplyClarificationArgValidator = v.object({
	...needsReplyClarificationValidator.fields,
	questions: v.array(needsReplyClarificationQuestionArgValidator),
});

/**
 * A question as stored: the argument shape without the legacy `attribution`
 * (N-1 shim, #1224, remove in 0.6.12 with the argument validators above).
 */
export function withoutLegacyAttribution<Q extends { attribution?: string }>(
	question: Q
): Omit<Q, 'attribution'> {
	const { attribution: _legacy, ...stored } = question;
	return stored;
}

/**
 * An optional clarification as stored: {@link withoutLegacyAttribution} on each
 * question (N-1 shim, #1224, remove in 0.6.12).
 */
export function withoutLegacyClarificationAttribution<
	R extends { clarification?: { questions: Array<{ attribution?: string }> } },
>(result: R) {
	const { clarification, ...rest } = result;
	if (clarification === undefined) return rest;
	return {
		...rest,
		clarification: {
			...clarification,
			questions: clarification.questions.map(withoutLegacyAttribution),
		},
	};
}
