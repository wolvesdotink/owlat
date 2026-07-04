'use node';

/**
 * "Coach my draft" — the middle rung between "suggest a reply" and "auto-draft"
 * for money / legal / bad-news mail people will not hand to an AI: it critiques
 * what the USER wrote without ever rewriting it. Pure reuse of the agent's
 * draft-quality self-check pass ({@link buildSelfCheckPrompt} +
 * {@link draftQualitySchema}) over the user's own text, surfaced as inline,
 * advisory-only suggestions. The user stays the author.
 *
 * Split out of mail/ai.ts to keep that file under the file-size ratchet; the
 * pure adapters ({@link categorizeCoachFlag}, {@link toCoachSuggestions}) are
 * exported for unit testing without a live model.
 */

import { v } from 'convex/values';
import { authedAction } from '../lib/authedFunctions';
import { api, internal } from '../_generated/api';
import { getLLMProvider } from '../lib/llmProvider';
import { runLlmObject } from '../lib/llm/dispatch';
import {
	buildSelfCheckPrompt,
	draftQualitySchema,
	type DraftQuality,
} from '../agent/steps/draft/index';
import { recordLlmSpend } from '../analytics/llmUsage';
import { threadToText } from './ai';

/**
 * Categories the flat self-check flags are bucketed into for inline display
 * next to the composer / review textarea.
 */
export type CoachCategory = 'tone' | 'ambiguity' | 'clarity' | 'missing-answer';

export interface CoachSuggestion {
	category: CoachCategory;
	message: string;
}

/** Bound the user's own draft that reaches the critique model. */
const COACH_MAX_DRAFT_CHARS = 8000;
/** Bound the (optional, untrusted) inbound context flattened into the prompt. */
const COACH_MAX_CONTEXT_CHARS = 6000;

/**
 * Best-effort bucketing of one free-form self-check flag into a coach category.
 * Pure + exported so the mapping is unit-testable without a live model. Order
 * matters: the most specific signal wins; anything unrecognised falls back to
 * `clarity` (the safe, non-alarming default for an advisory nudge).
 */
export function categorizeCoachFlag(flag: string): CoachCategory {
	const f = flag.toLowerCase();
	if (
		/\b(unanswer|unaddress|missing|incomplete|does ?n'?t answer|no answer|left out|ignore[sd]? the|fails to address)\b/.test(
			f,
		)
	) {
		return 'missing-answer';
	}
	if (/\b(tone|rude|curt|harsh|abrupt|cold|aggressive|dismissive|formal|informal|polite)\b/.test(f)) {
		return 'tone';
	}
	if (/\b(ambig|vague|unclear which|could mean|open to interpretation|which \w+ do you|non-committal)\b/.test(f)) {
		return 'ambiguity';
	}
	return 'clarity';
}

/**
 * Adapt the reused draft-quality self-check output into inline coach
 * suggestions. Pure + exported so both the weak-draft and clean-draft cases can
 * be asserted without a network call. A clean self-check (high score, complete,
 * grounded, no flags) yields NO suggestions; `null` (the fail-soft self-check
 * result) also yields none — the coach is advisory and stays silent on
 * uncertainty rather than inventing critique. The draft is never returned or
 * mutated here; the user stays the author.
 */
export function toCoachSuggestions(quality: DraftQuality | null): CoachSuggestion[] {
	if (!quality) return [];
	const suggestions: CoachSuggestion[] = [];
	const seen = new Set<string>();
	const push = (category: CoachCategory, message: string) => {
		const key = message.trim().toLowerCase();
		if (!key || seen.has(key)) return;
		seen.add(key);
		suggestions.push({ category, message: message.trim() });
	};
	for (const flag of quality.flags) {
		if (typeof flag === 'string' && flag.trim()) push(categorizeCoachFlag(flag), flag);
	}
	// Ensure the two structured signals surface even when the model returned no
	// matching free-form flag for them.
	if (!quality.complete && !suggestions.some((s) => s.category === 'missing-answer')) {
		push('missing-answer', 'The reply may not fully address everything the message asked.');
	}
	if (!quality.grounded && !suggestions.some((s) => s.category === 'clarity')) {
		push('clarity', 'Some statements may not be grounded in the thread — double-check the facts.');
	}
	return suggestions;
}

/**
 * "Coach my draft": run the SAME cheap-tier draft-quality self-check pass the
 * agent runs on its own generated drafts, but over the USER's own text, and
 * surface the critique as inline suggestions (tone / ambiguity / clarity /
 * missing-answer). This is the middle rung for high-stakes mail: it never
 * rewrites and never returns replacement text — the user stays the author.
 *
 * Advisory + FAIL-SOFT: any failure (LLM error, missing provider, malformed
 * object) resolves to an empty suggestion list — a no-op that leaves the draft
 * exactly as the user typed it. Gated behind the `ai` flag + per-user rate
 * limit via aiGate; the client additionally hides the action when `ai` is off.
 */
// authz: org membership enforced by authedAction; the `ai` flag + per-user rate
// limit enforced by aiGate.assertAiAllowed. Operates on the caller's own draft
// text; when `messageId` is given, ownership is enforced by
// mail.mailbox.listThreadMessages (returns null for a non-owned message) and the
// thread is used as READ-ONLY context only.
export const coachDraft = authedAction({
	args: {
		draftText: v.string(),
		// Optional inbound context: either a thread the caller owns, or a bounded
		// free-text context string (e.g. the review-gate escalation body).
		messageId: v.optional(v.id('mailMessages')),
		threadContext: v.optional(v.string()),
	},
	handler: async (ctx, args): Promise<{ suggestions: CoachSuggestion[] }> => {
		const draft = args.draftText.trim();
		if (!draft) return { suggestions: [] };
		try {
			await ctx.runMutation(internal.mail.aiGate.assertAiAllowed, {});
			let context = (args.threadContext ?? '').slice(0, COACH_MAX_CONTEXT_CHARS);
			if (args.messageId) {
				const thread = await ctx.runQuery(api.mail.mailbox.listThreadMessages, {
					messageId: args.messageId,
				});
				if (thread && thread.messages.length > 0) {
					context = threadToText(thread.messages);
				}
			}
			const { object, tokenUsage, modelUsed } = await runLlmObject({
				model: getLLMProvider('classify'), // cheap / fast tier, same as the agent self-check
				schema: draftQualitySchema,
				prompt: buildSelfCheckPrompt({
					context,
					draft: draft.slice(0, COACH_MAX_DRAFT_CHARS),
				}),
				temperature: 0.1,
			});
			// Best-effort spend accounting — never let it break the coach.
			try {
				await recordLlmSpend(ctx, 'postbox_coach_draft', tokenUsage, modelUsed);
			} catch {
				// ignore — spend accounting is advisory
			}
			return {
				suggestions: toCoachSuggestions({
					score: object.score,
					complete: object.complete,
					grounded: object.grounded,
					flags: object.flags,
				}),
			};
		} catch {
			// FAIL-SOFT: no critique is better than blocking the user's own draft.
			return { suggestions: [] };
		}
	},
});
