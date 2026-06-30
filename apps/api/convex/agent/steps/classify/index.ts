'use node';

/**
 * `classify` Agent step (module) — see ADR-0014.
 *
 * Classifies an inbound message by category / priority / sentiment /
 * intent / confidence using structured LLM output (generateObject).
 * Routes to:
 *   - archived (spam category)
 *   - draft_ready (complaint or urgent — skip drafter, human review)
 *   - drafting (everything else — schedule drafter)
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

		// Complaint / urgent — escalate to human review, skip drafter
		if (output.category === 'complaint' || output.priority === 'urgent') {
			return {
				kind: 'transition',
				transition: { to: 'draft_ready', classification: output },
			};
		}

		// Normal — schedule drafter, threading the context forward
		return {
			kind: 'transition',
			transition: { to: 'drafting', classification: output },
			nextStep: {
				kind: 'draft',
				input: {
					inboundMessageId: runCtx.inboundMessageId,
					context: input.context,
					classification: output,
				},
			},
		};
	},
};
