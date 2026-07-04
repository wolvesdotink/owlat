'use node';

/**
 * Natural-language handling rules — the COMPILE seam.
 *
 * The user writes a standing instruction in plain English ("always decline cold
 * recruiter pitches", "flag anything from legal for me"). This action compiles
 * that TRUSTED, user-authored prose ONCE, with a cheap-tier LLM, into the
 * deterministic `{ matcher, action }` the engine (./handlingRules/engine.ts)
 * executes at classify time. Because compilation happens on the trusted rule
 * text only — never on an inbound email — and the matcher itself is pure JS,
 * an untrusted message never reaches a model through a rule.
 *
 * This action does NOT persist. It returns a compiled preview the client can
 * review, edit, then save via mail.handlingRules.create (owner/admin only) — so
 * a human always confirms the compiled matcher before it can govern the inbox.
 *
 * FAIL-SOFT: any compile failure surfaces as an error to the caller (the rule is
 * simply not created); it never touches ingest, the walker, or auto-send.
 */

import { z } from 'zod';
import { v } from 'convex/values';
import { authedAction } from '../lib/authedFunctions';
import { internal } from '../_generated/api';
import { getLLMProvider } from '../lib/llmProvider';
import { runLlmObject } from '../lib/llm/dispatch';
import { recordLlmSpend } from '../analytics/llmUsage';
import { throwInvalidInput } from '../_utils/errors';

/** The compiled rule shape the model must return. */
const compiledRuleSchema = z.object({
	matcher: z
		.object({
			senders: z
				.array(z.string())
				.optional()
				.describe('Case-insensitive substrings to match the sender address/name (e.g. a domain).'),
			subjectContains: z
				.array(z.string())
				.optional()
				.describe('Case-insensitive substrings to match in the subject.'),
			bodyContains: z
				.array(z.string())
				.optional()
				.describe('Case-insensitive substrings to match in the body.'),
			categories: z
				.array(
					z.enum([
						'support',
						'sales',
						'billing',
						'feature_request',
						'complaint',
						'spam',
						'internal',
						'other',
					])
				)
				.optional()
				.describe('Classifier categories this rule applies to.'),
		})
		.describe('At least one facet MUST be present; facets are AND-ed at match time.'),
	action: z
		.object({
			type: z.enum([
				'draft_with_stance',
				'categorize',
				'auto_archive',
				'always_ask',
				'never_auto_send',
			]),
			stance: z
				.string()
				.optional()
				.describe('For draft_with_stance: the stance to draft in, e.g. "a polite decline".'),
			category: z
				.string()
				.optional()
				.describe('For categorize: the category to force onto the message.'),
		})
		.describe('What to do when the matcher fires.'),
});

export type CompiledRule = z.infer<typeof compiledRuleSchema>;

/**
 * Build the compile prompt. Pure + exported so the unit test can assert the
 * framing without a live model. The rule text is trusted (the user typed it), so
 * there is no untrusted-data guard here — the safety boundary is that the
 * COMPILED matcher runs deterministically, never re-invoking the model on mail.
 */
export function buildCompilePrompt(instruction: string): string {
	return (
		`Compile the user's plain-English email-handling rule into a structured ` +
		`matcher + action.\n\n` +
		`Rules:\n` +
		`- The matcher MUST have at least one facet (senders, subjectContains, ` +
		`bodyContains, or categories). Prefer the narrowest facets that capture the ` +
		`intent.\n` +
		`- Pick exactly one action:\n` +
		`  - draft_with_stance (+stance) — pre-draft a reply in a stance ("a polite decline").\n` +
		`  - categorize (+category) — force a classifier category.\n` +
		`  - auto_archive — archive without a reply.\n` +
		`  - always_ask — always hold for human review.\n` +
		`  - never_auto_send — never autonomously send; a human must review.\n` +
		`- "senders" entries are substrings (a bare domain like "acme.com" is fine).\n\n` +
		`User rule:\n${instruction}`
	);
}

/** Hard cap on the compiled facet sizes — a rule is standing intent, not a filter list. */
const MAX_FACET_ENTRIES = 20;

function boundFacet(entries: string[] | undefined): string[] | undefined {
	if (!entries) return undefined;
	const cleaned: string[] = [];
	for (const raw of entries) {
		const trimmed = raw.trim();
		if (trimmed.length > 0) cleaned.push(trimmed.slice(0, 200));
		if (cleaned.length >= MAX_FACET_ENTRIES) break;
	}
	return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Compile a natural-language rule into a structured `{ matcher, action }`
 * preview. Login-gated + AI-gated (flag / budget / rate limit) via
 * `assertAiAllowed`. Does NOT persist — the client reviews the preview and saves
 * it via `mail.handlingRules.create` (owner/admin only).
 */
// authz: org membership enforced by authedAction; the `ai` flag + budget +
// per-user rate limit enforced by aiGate.assertAiAllowed. Preview generation is
// intentionally open to any authenticated member — it does NOT persist, and the
// owner/admin write gate lives on mail.handlingRules.create.
export const compile = authedAction({
	args: { instruction: v.string() },
	handler: async (ctx, args): Promise<CompiledRule & { compiledModel?: string }> => {
		const instruction = args.instruction.trim();
		if (!instruction) throwInvalidInput('Rule text is required');

		// Flag / budget / rate-limit gate, shared with the advisory Postbox AI.
		await ctx.runMutation(internal.mail.aiGate.assertAiAllowed, {});

		const model = getLLMProvider('classify'); // cheap tier — this is a light extraction
		const { object, tokenUsage, modelUsed } = await runLlmObject({
			model,
			schema: compiledRuleSchema,
			prompt: buildCompilePrompt(instruction),
			temperature: 0,
		});
		await recordLlmSpend(ctx, 'handling_rule_compile', tokenUsage, modelUsed);

		// Bound the compiled facets defensively (the model output is structured but
		// still model-authored) before it is shown for review / saved.
		const matcher = {
			senders: boundFacet(object.matcher.senders),
			subjectContains: boundFacet(object.matcher.subjectContains),
			bodyContains: boundFacet(object.matcher.bodyContains),
			categories: boundFacet(object.matcher.categories),
		};
		const hasFacet =
			(matcher.senders?.length ?? 0) > 0 ||
			(matcher.subjectContains?.length ?? 0) > 0 ||
			(matcher.bodyContains?.length ?? 0) > 0 ||
			(matcher.categories?.length ?? 0) > 0;
		if (!hasFacet) {
			throwInvalidInput(
				'Could not compile a specific matcher from that instruction — try naming a sender, subject, or topic.'
			);
		}

		return { matcher, action: object.action, compiledModel: modelUsed };
	},
});
