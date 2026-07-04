import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { tokenUsageValidator } from '../lib/convexValidators';

/**
 * Ephemeral, owner-private streaming buffers for the whole-draft REVISE loop
 * (mail/reviseDraft.ts). A revise re-writes an ENTIRE draft from a freeform
 * user instruction layered over the (untrusted) thread; the action drives
 * `runLlmStream` and throttle-patches the accumulating `text` here, so the
 * caller's reactive `useConvexQuery(getDraftStream)` subscription renders tokens
 * progressively into the review pane / Postbox composer instead of staring at a
 * spinner.
 *
 * Privacy: a row is OWNED by one user (`ownerId` = BetterAuth user id) and is
 * only ever readable by that user (getDraftStream is owner-scoped). These are
 * short-lived scratch rows — the client deletes its row once it applies or
 * discards the result — so they carry no thread/mailbox linkage.
 *
 * Fail-soft: the streamed text is ADVISORY. Safety scanning of the FINAL text
 * (prompt-injection / recipient-lock) runs once at finalize and only sets an
 * advisory flag; it never auto-sends and never blocks the human from editing.
 *
 * Spread into `defineSchema()` from schema.ts via `...draftStreamTables`.
 */
export const draftStreamTables = {
	aiDraftStreams: defineTable({
		// BetterAuth user id — the sole owner. Reads are owner-scoped.
		ownerId: v.string(),
		// Which surface asked for the revise (analytics / display only).
		surface: v.union(v.literal('compose'), v.literal('review')),
		// Lifecycle: streaming → complete | error.
		status: v.union(
			v.literal('streaming'),
			v.literal('complete'),
			v.literal('error')
		),
		// Accumulates as tokens arrive; the final revised draft on complete.
		text: v.string(),
		// Advisory: set true when the FINAL text tripped the outbound
		// prompt-injection scan. Surfaced to the human; never auto-sends.
		injectionFlagged: v.optional(v.boolean()),
		model: v.optional(v.string()),
		tokenUsage: v.optional(tokenUsageValidator),
		errorMessage: v.optional(v.string()),
		createdAt: v.number(),
		updatedAt: v.number(),
	}).index('by_owner', ['ownerId']),
};
