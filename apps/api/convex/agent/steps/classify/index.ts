'use node';

/**
 * `classify` Agent step (module) — see ADR-0014.
 *
 * Classifies an inbound message by category / priority / sentiment /
 * intent / confidence using structured LLM output (generateObject).
 * Routes to:
 *   - archived (spam category)
 *   - clarify (everything else — the missing-info gate, in-state, before the
 *     drafter). Complaint / urgent mail is forked through here too (it used to
 *     skip straight to a blank human-review box); the `clarify` step runs it
 *     with cautious eagerness, and the `route` step keeps the hard rule that
 *     complaint / urgent are never auto-send-eligible.
 */

import { z } from 'zod';
import { getLLMProvider } from '../../../lib/llmProvider';
import { internal } from '../../../_generated/api';
import type { Id } from '../../../_generated/dataModel';
import type { AgentStepModule } from '../types';
import { runLlmObject } from '../../../lib/llm/dispatch';
import { evaluateHandlingRules, toHandlingEvalMessage } from '../../../mail/handlingRules';

const classificationSchema = z.object({
	category: z
		.enum([
			'support', 'sales', 'billing', 'feature_request',
			'complaint', 'spam', 'internal', 'other',
		])
		.describe('The primary category of this message'),
	priority: z
		.enum(['urgent', 'normal', 'low'])
		.describe('How urgently this needs attention'),
	sentiment: z
		.enum(['positive', 'neutral', 'negative'])
		.describe('The emotional tone of the message'),
	intent: z
		.enum([
			'question', 'complaint', 'request', 'information',
			'escalation', 'acknowledgment',
		])
		.describe('What the sender is trying to do'),
	confidence: z
		.number()
		.min(0)
		.max(1)
		.describe('How confident you are in this classification (0-1)'),
});

export type ClassifyInput = {
	inboundMessageId: Id<'inboundMessages'>;
	context: string;
};

export type ClassifyOutput = z.infer<typeof classificationSchema> & {
	// Set by deterministic natural-language handling rules (mail/handlingRules):
	// an `auto_archive` rule matched this message, so `route()` sends it straight
	// to archived. Absent/false = normal flow.
	handlingAutoArchive?: boolean;
};

const CLASSIFY_CATEGORIES = [
	'support',
	'sales',
	'billing',
	'feature_request',
	'complaint',
	'spam',
	'internal',
	'other',
] as const;
type ClassifyCategory = (typeof CLASSIFY_CATEGORIES)[number];

function isClassifyCategory(value: string): value is ClassifyCategory {
	for (const c of CLASSIFY_CATEGORIES) {
		if (c === value) return true;
	}
	return false;
}

export const classifyStep: AgentStepModule<'classify', ClassifyInput, ClassifyOutput> = {
	kind: 'classify',
	llm: { tier: 'fast' },

	async execute(ctx, input) {
		const model = getLLMProvider('classify');

		const { object, tokenUsage, modelUsed } = await runLlmObject({
			model,
			schema: classificationSchema,
			prompt: `Classify the following email message. Consider the full context provided.

${input.context}

Classify this message with:
- category: the primary topic (support, sales, billing, feature_request, complaint, spam, internal, other)
- priority: how urgently this needs attention (urgent, normal, low)
- sentiment: the emotional tone (positive, neutral, negative)
- intent: what the sender is trying to accomplish (question, complaint, request, information, escalation, acknowledgment)
- confidence: how confident you are in this classification (0.0 to 1.0)`,
			temperature: 0.2,
		});

		// Deterministic natural-language handling rules (mail/handlingRules).
		// FAIL-SOFT: any error evaluating rules leaves the LLM classification
		// exactly as-is — rules never block or corrupt ingest.
		let output: ClassifyOutput = object;
		try {
			const rules = await ctx.runQuery(internal.mail.handlingRules.listActiveInternal, {});
			if (rules.length > 0) {
				const message = await ctx.runQuery(internal.agent.agentPipeline.getMessage, {
					inboundMessageId: input.inboundMessageId,
				});
				if (message) {
					const outcome = evaluateHandlingRules(rules, toHandlingEvalMessage(message));
					// `categorize` forces the classification category (only if it is a
					// real category the pipeline understands).
					//
					// SECURITY — restrict-only: a categorize rule may NEVER move a
					// message OUT of the protected complaint category or off urgent
					// priority. The route step's fail-closed complaint/urgent hard-block
					// (route/index.ts) keys off the persisted classification, so allowing
					// an attacker-craftable inbound to match a benign categorize rule and
					// re-label a complaint as e.g. `support` would strip that guaranteed
					// human review — a WIDENING of the auto-send set via a rule. Evaluate
					// the hard-block on the ORIGINAL classifier signal: when the original
					// classification is complaint/urgent, the forced category is dropped.
					// (Forcing a category INTO complaint only ever adds protection, so it
					// is allowed.)
					const originalProtected =
						object.category === 'complaint' || object.priority === 'urgent';
					if (
						outcome.forcedCategory &&
						isClassifyCategory(outcome.forcedCategory) &&
						!originalProtected
					) {
						output = { ...output, category: outcome.forcedCategory };
					}
					// `auto_archive` short-circuits to archived in route().
					if (outcome.autoArchive) {
						output = { ...output, handlingAutoArchive: true };
					}
				}
			}
		} catch {
			// swallowed: handling rules are best-effort; classification stands
		}

		return { output, tokenUsage, modelUsed };
	},

	route(output, input, runCtx) {
		// A natural-language `auto_archive` handling rule matched — archive
		// without a reply, same terminal edge as spam.
		if (output.handlingAutoArchive) {
			return {
				kind: 'transition',
				transition: { to: 'archived', reason: 'handling_rule_archive' },
			};
		}

		// Spam — archive
		if (output.category === 'spam') {
			return {
				kind: 'transition',
				transition: { to: 'archived', reason: 'classifier_spam' },
			};
		}

		// Everything else — run the missing-info gate IN-STATE before drafting.
		// The clarify step decides whether the agent must ask a question first
		// (→ awaiting_clarification) or can proceed to draft (→ drafting).
		// Complaint / urgent flow through here as well; clarify runs them with
		// cautious eagerness and route keeps them out of the auto-send path.
		return {
			kind: 'in_state',
			nextStep: {
				kind: 'clarify',
				input: {
					inboundMessageId: runCtx.inboundMessageId,
					context: input.context,
					classification: output,
				},
			},
		};
	},
};
