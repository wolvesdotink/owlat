import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { answerAskStatusValidator, answerAskTargetValidator } from '../lib/validators/answerAsk';
import {
	clarificationFileRefValidator,
	needsReplyClarificationQuestionValidator,
} from '../lib/validators/clarification';

/**
 * Answer mode ask sessions (mail/ai/composeDraft.ts): "Draft with AI" checks
 * for gaps first, asks up to three questions per round, then streams the draft
 * into an `aiDraftStreams` buffer.
 *
 * One live session per (target, owner): starting again on the same draft or
 * team thread replaces the caller's previous session. A row is private to its
 * owner (every public read checks `ownerId`), and it survives a reload, so
 * closing Answer mode halfway and coming back resumes at the ask card.
 *
 * The questions reuse the Postbox clarification question shape, including the
 * file answers and near-match candidates Answer mode added. Question text is
 * derived from attacker-controlled mail; it was sanitized (credential filter)
 * before it was stored.
 *
 * Spread into `defineSchema()` from schema.ts via `...answerAskTables`.
 */
export const answerAskTables = {
	answerAskSessions: defineTable({
		// BetterAuth user id of the person drafting. Reads are owner-scoped.
		ownerId: v.string(),
		organizationId: v.string(),
		target: answerAskTargetValidator,
		// lib/validators/answerAsk.ts answerAskTargetKey(target).
		targetKey: v.string(),
		// The owner's optional "what should the reply say" (trusted input).
		instruction: v.optional(v.string()),
		// Interface locale the questions are shown in.
		locale: v.string(),
		// 1 while the first questions are open, 2 after an answer opened a new gap.
		round: v.number(),
		status: answerAskStatusValidator,
		questions: v.array(needsReplyClarificationQuestionValidator),
		// The buffer the draft streams into, owned by `ownerId`.
		streamId: v.optional(v.id('aiDraftStreams')),
		// Files attached to the reply (mailDraft) or to be attached by the web
		// (teamThread): found automatically or given as answers.
		attachedFiles: v.array(clarificationFileRefValidator),
		// When the owner said they will send the missing file; the draft promises
		// it and a mail draft's follow-up reminder is set to it.
		followUpAt: v.optional(v.number()),
		// The contact the reply goes to, resolved at start: answer memory and
		// file search are scoped to it. Absent when no contact matched.
		contactId: v.optional(v.id('contacts')),
		// The other party's address (answer memory falls back to it).
		counterpartAddress: v.optional(v.string()),
		// The file the other party asked for, when one was detected: the id of
		// its question and the short label its gap placeholder uses.
		fileRequest: v.optional(v.object({ questionId: v.string(), label: v.string() })),
		errorMessage: v.optional(v.string()),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		// The caller's live session for one target; the targetKey prefix alone
		// answers "does this draft have an ask session" for the send guard.
		.index('by_target_owner', ['targetKey', 'ownerId'])
		// Member erasure drops a departing member's sessions.
		.index('by_owner', ['ownerId'])
		// Contact erasure drops every session about the erased person.
		.index('by_contact', ['contactId']),
};
