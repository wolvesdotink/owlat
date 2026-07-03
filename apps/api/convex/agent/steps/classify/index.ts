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
import type { Id } from '../../../_generated/dataModel';
import type { AgentStepModule } from '../types';
import { runLlmObject } from '../../../lib/llm/dispatch';

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

export type ClassifyOutput = z.infer<typeof classificationSchema>;

export const classifyStep: AgentStepModule<'classify', ClassifyInput, ClassifyOutput> = {
	kind: 'classify',
	llm: { tier: 'fast' },

	async execute(_ctx, input) {
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

		return { output: object, tokenUsage, modelUsed };
	},

	route(output, input, runCtx) {
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
