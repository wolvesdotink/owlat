import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * Natural-language handling rules — standing intent the user teaches in prose.
 *
 * The user writes a plain-English rule ("draft a polite decline for
 * recruiters", "flag anything from legal for me"); a cheap LLM compiles the
 * trusted, user-authored `naturalLanguage` into a deterministic `matcher`
 * (AND-ed conditions over the untrusted inbound email) + an `action`. Rules are
 * executed deterministically at classify time (categorize / auto-archive) and
 * at the auto-send gate (a rule can only ever RESTRICT auto-send — never widen
 * it). Inspectable + editable + revocable in settings.
 *
 * Spread into `defineSchema()` from schema.ts via `...handlingRulesTables`.
 */
export const handlingRulesTables = {
	// A row is only consulted while `status: 'active'` AND `isEnabled`, so a
	// still-compiling or failed compile is inert and never touches the pipeline
	// (fail-soft).
	handlingRules: defineTable({
		// The user's plain-English rule text (trusted; author is the org owner).
		naturalLanguage: v.string(),
		// Compilation lifecycle. Only 'active' rows with a `matcher` are evaluated.
		status: v.union(v.literal('compiling'), v.literal('active'), v.literal('failed')),
		// Deterministic matcher produced by the compiler. AND-ed conditions.
		matcher: v.optional(
			v.object({
				conditions: v.array(
					v.object({
						field: v.union(v.literal('from'), v.literal('subject'), v.literal('body')),
						op: v.union(v.literal('contains'), v.literal('equals'), v.literal('matches')),
						value: v.string(),
					})
				),
			})
		),
		// What to do when the matcher fires. Restricting actions
		// (draft_with_stance / always_ask / never_auto_send) can only force human
		// review; categorize / auto_archive shape classification.
		action: v.optional(
			v.union(
				v.literal('draft_with_stance'),
				v.literal('categorize'),
				v.literal('auto_archive'),
				v.literal('always_ask'),
				v.literal('never_auto_send')
			)
		),
		// For draft_with_stance — the stance the drafter should take.
		stance: v.optional(v.string()),
		// For categorize — the classification category to force.
		category: v.optional(v.string()),
		// Populated when status: 'failed' — surfaced in settings for the user.
		compileError: v.optional(v.string()),
		isEnabled: v.boolean(),
		createdAt: v.number(),
		updatedAt: v.number(),
	}).index('by_status', ['status']),
};
