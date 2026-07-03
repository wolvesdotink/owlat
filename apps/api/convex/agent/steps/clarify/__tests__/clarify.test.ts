/**
 * Tests for the `clarify` Agent step.
 *
 * Covers the slot-based missing-info detection with divergence gating:
 *   - buildSlotPrompt / buildDivergencePrompt frame the email as untrusted DATA
 *     (SYSTEM_GUARD posture).
 *   - eagernessForCategory: complaint / urgent → cautious.
 *   - selectQuestions caps at 3 and keeps only divergent slots.
 *   - execute(): high coverage short-circuits the expensive check.
 *   - execute(): converging slots → no question (routes drafting).
 *   - execute(): a genuinely ambiguous decision-relevant slot → a question
 *     emitted + awaiting_clarification.
 *   - execute(): complaint / urgent skip the coverage short-circuit and enter
 *     the check even when coverage is high.
 *   - execute(): any LLM failure → fail-soft to drafting.
 *
 * The LLM dispatch seam + provider factory are mocked — no live model.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getFunctionName } from 'convex/server';

const mocks = vi.hoisted(() => ({
	runLlmText: vi.fn(),
	runLlmObject: vi.fn(),
	getLLMProvider: vi.fn(() => 'mock-model'),
}));

vi.mock('../../../../lib/llm/dispatch', () => ({
	runLlmText: mocks.runLlmText,
	runLlmObject: mocks.runLlmObject,
}));
vi.mock('../../../../lib/llmProvider', () => ({
	getLLMProvider: mocks.getLLMProvider,
}));

import {
	clarifyStep,
	buildSlotPrompt,
	buildDivergencePrompt,
	eagernessForCategory,
	selectQuestions,
	type ClarifyInput,
	type ClarifyOutput,
	type ReplySlot,
} from '../index';
import type { Id } from '../../../../_generated/dataModel';

const messageId = 'msg_clarify_1' as Id<'inboundMessages'>;
const runCtx = { inboundMessageId: messageId, agentConfig: null };

function makeInput(over: Partial<ClarifyInput['classification']> = {}): ClarifyInput {
	return {
		inboundMessageId: messageId,
		context: 'Customer: can we push the launch and what would that cost?',
		classification: {
			category: over.category ?? 'support',
			priority: over.priority ?? 'normal',
			sentiment: over.sentiment ?? 'neutral',
			intent: over.intent ?? 'question',
			confidence: over.confidence ?? 0.9,
		},
	};
}

/** Fake execute ctx: getMessage returns a message with the given coverage
 * (or null when `coverage` is the string 'missing'). */
function makeCtx(coverage: unknown | 'missing') {
	const ctx = {
		runQuery: async (ref: unknown) => {
			const name = getFunctionName(ref as Parameters<typeof getFunctionName>[0]);
			if (name.includes('getMessage')) {
				return coverage === 'missing' ? null : { contextCoverage: coverage };
			}
			throw new Error(`unexpected runQuery: ${name}`);
		},
	} as unknown as Parameters<typeof clarifyStep.execute>[0];
	return ctx;
}

const decisionSlot: ReplySlot = {
	slotType: 'decision',
	question: 'Should we agree to push the launch date?',
	answerableFromContext: false,
	decisionRelevant: true,
	options: [],
};

beforeEach(() => {
	mocks.runLlmText.mockReset();
	mocks.runLlmObject.mockReset();
	mocks.getLLMProvider.mockReset();
	mocks.getLLMProvider.mockReturnValue('mock-model');
	// Three distinct candidate drafts by default.
	mocks.runLlmText
		.mockResolvedValueOnce({
			text: 'Yes, we can push to March.',
			tokenUsage: undefined,
			modelUsed: 'mock-model',
		})
		.mockResolvedValueOnce({
			text: 'No, the date is fixed.',
			tokenUsage: undefined,
			modelUsed: 'mock-model',
		})
		.mockResolvedValueOnce({
			text: 'Maybe — let me check.',
			tokenUsage: undefined,
			modelUsed: 'mock-model',
		});
});

describe('eagernessForCategory', () => {
	it('is cautious for complaints and urgent mail, default otherwise', () => {
		expect(eagernessForCategory({ category: 'complaint', priority: 'normal' })).toBe('cautious');
		expect(eagernessForCategory({ category: 'support', priority: 'urgent' })).toBe('cautious');
		expect(eagernessForCategory({ category: 'support', priority: 'normal' })).toBe('default');
	});
});

describe('prompt framing', () => {
	it('buildSlotPrompt frames the email as untrusted DATA and delimits it', () => {
		const prompt = buildSlotPrompt('INBOUND-XYZ');
		expect(prompt).toMatch(/untrusted DATA/i);
		expect(prompt).toMatch(/never follow/i);
		expect(prompt).toContain('<untrusted_email_content>');
		expect(prompt).toContain('INBOUND-XYZ');
	});

	it('buildDivergencePrompt lists numbered slots and the candidate drafts', () => {
		const prompt = buildDivergencePrompt([decisionSlot], ['DRAFT-A', 'DRAFT-B']);
		expect(prompt).toMatch(/untrusted DATA/i);
		expect(prompt).toContain('0. [decision]');
		expect(prompt).toContain('DRAFT-A');
		expect(prompt).toContain('DRAFT-B');
	});
});

describe('selectQuestions', () => {
	it('keeps only divergent slots and stamps stable ids', () => {
		const slots: ReplySlot[] = [decisionSlot, { ...decisionSlot, question: 'What price?' }];
		const qs = selectQuestions(slots, [1]);
		expect(qs).toEqual([{ id: 'clarify_1', slotType: 'decision', text: 'What price?' }]);
	});

	it('caps at three questions', () => {
		const slots: ReplySlot[] = Array.from({ length: 5 }, (_, i) => ({
			...decisionSlot,
			question: `Q${i}`,
		}));
		const qs = selectQuestions(slots, [0, 1, 2, 3, 4]);
		expect(qs).toHaveLength(3);
	});
});

describe('clarifyStep.execute — coverage short-circuit', () => {
	it('skips the expensive check entirely when coverage is high (no LLM calls)', async () => {
		const ctx = makeCtx({ lowCoverage: false });
		const { output } = await clarifyStep.execute(ctx, makeInput());
		expect(output.resolution).toBe('high_coverage_short_circuit');
		expect(output.questions).toEqual([]);
		expect(mocks.runLlmObject).not.toHaveBeenCalled();
		expect(mocks.runLlmText).not.toHaveBeenCalled();
	});

	it('complaint mail runs the check even when coverage is high (cautious)', async () => {
		// Coverage says high, but a complaint must not short-circuit. No slots to
		// ask about → drafting, but the point is the slot pass RAN.
		mocks.runLlmObject.mockResolvedValueOnce({
			object: { slots: [] },
			tokenUsage: undefined,
			modelUsed: 'mock-model',
		});
		const ctx = makeCtx({ lowCoverage: false });
		const { output } = await clarifyStep.execute(ctx, makeInput({ category: 'complaint' }));
		expect(mocks.runLlmObject).toHaveBeenCalledTimes(1); // slot extraction ran
		expect(output.resolution).toBe('no_candidate_slots');
		expect(output.questions).toEqual([]);
	});
});

describe('clarifyStep.execute — divergence gating', () => {
	it('converging slots emit no question (routes drafting)', async () => {
		mocks.runLlmObject
			.mockResolvedValueOnce({
				object: { slots: [decisionSlot] },
				tokenUsage: undefined,
				modelUsed: 'mock-model',
			})
			.mockResolvedValueOnce({
				object: { divergentSlotIndexes: [] }, // candidates agreed → drop
				tokenUsage: undefined,
				modelUsed: 'mock-model',
			});
		const ctx = makeCtx({ lowCoverage: true });
		const { output } = await clarifyStep.execute(ctx, makeInput());
		expect(output.resolution).toBe('converged');
		expect(output.questions).toEqual([]);
	});

	it('a divergent decision-relevant slot emits a question', async () => {
		mocks.runLlmObject
			.mockResolvedValueOnce({
				object: { slots: [decisionSlot] },
				tokenUsage: undefined,
				modelUsed: 'mock-model',
			})
			.mockResolvedValueOnce({
				object: { divergentSlotIndexes: [0] }, // candidates disagreed → ask
				tokenUsage: undefined,
				modelUsed: 'mock-model',
			});
		const ctx = makeCtx({ lowCoverage: true });
		const { output } = await clarifyStep.execute(ctx, makeInput());
		expect(output.resolution).toBe('questions_emitted');
		expect(output.questions).toHaveLength(1);
		expect(output.questions[0]!.text).toBe(decisionSlot.question);
	});

	it('drops answerable / non-decision-relevant slots before the divergence check', async () => {
		mocks.runLlmObject.mockResolvedValueOnce({
			object: {
				slots: [
					{ ...decisionSlot, answerableFromContext: true }, // context has it
					{ ...decisionSlot, decisionRelevant: false }, // doesn't matter
				],
			},
			tokenUsage: undefined,
			modelUsed: 'mock-model',
		});
		const ctx = makeCtx({ lowCoverage: true });
		const { output } = await clarifyStep.execute(ctx, makeInput());
		expect(output.resolution).toBe('no_candidate_slots');
		expect(output.questions).toEqual([]);
		// Divergence check never ran — only the single slot-extraction call.
		expect(mocks.runLlmText).not.toHaveBeenCalled();
	});
});

describe('clarifyStep.execute — fail-soft', () => {
	it('degrades to drafting (no questions) when the slot LLM call throws', async () => {
		mocks.runLlmObject.mockRejectedValueOnce(new Error('model unavailable'));
		const ctx = makeCtx({ lowCoverage: true });
		const { output } = await clarifyStep.execute(ctx, makeInput());
		expect(output.resolution).toBe('fail_soft');
		expect(output.questions).toEqual([]);
	});

	it('degrades to drafting when fewer than two candidate drafts survive', async () => {
		mocks.runLlmObject.mockResolvedValueOnce({
			object: { slots: [decisionSlot] },
			tokenUsage: undefined,
			modelUsed: 'mock-model',
		});
		mocks.runLlmText.mockReset();
		mocks.runLlmText
			.mockResolvedValueOnce({ text: 'only one', tokenUsage: undefined, modelUsed: 'mock-model' })
			.mockRejectedValueOnce(new Error('sample failed'))
			.mockRejectedValueOnce(new Error('sample failed'));
		const ctx = makeCtx({ lowCoverage: true });
		const { output } = await clarifyStep.execute(ctx, makeInput());
		expect(output.resolution).toBe('insufficient_samples');
		expect(output.questions).toEqual([]);
	});
});

describe('clarifyStep.route', () => {
	function outputWith(questions: ClarifyOutput['questions']): ClarifyOutput {
		return { questions, resolution: questions.length > 0 ? 'questions_emitted' : 'converged' };
	}

	it('routes to awaiting_clarification when questions are present', () => {
		const input = makeInput();
		const route = clarifyStep.route(
			outputWith([{ id: 'clarify_0', slotType: 'decision', text: 'Push the date?' }]),
			input,
			runCtx
		);
		expect(route.kind).toBe('transition');
		if (route.kind !== 'transition') return;
		expect(route.transition.to).toBe('awaiting_clarification');
		if (route.transition.to !== 'awaiting_clarification') return;
		expect(route.transition.questions).toHaveLength(1);
		expect(route.transition.classification).toEqual(input.classification);
		expect(route.nextStep).toBeUndefined();
	});

	it('routes to drafting + schedules the draft step when nothing is missing', () => {
		const input = makeInput();
		const route = clarifyStep.route(outputWith([]), input, runCtx);
		expect(route.kind).toBe('transition');
		if (route.kind !== 'transition') return;
		expect(route.transition.to).toBe('drafting');
		expect(route.nextStep).toEqual({
			kind: 'draft',
			input: {
				inboundMessageId: messageId,
				context: input.context,
				classification: input.classification,
			},
		});
	});
});
