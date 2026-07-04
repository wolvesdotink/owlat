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
	buildMemoryConfirmedContext,
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

type Mode = 'cautious' | 'balanced' | 'confident' | 'off' | null;

/** Fake execute ctx: getMessage returns a message with the given coverage
 * (or null when `coverage` is the string 'missing'); getAskEagernessInternal
 * returns `mode` (null = no setting = today's behaviour). `asked` captures the
 * ask-instrumentation rows written via runMutation. */
function makeCtx(
	coverage: unknown | 'missing',
	mode: Mode = null,
	fills: { questionId: string; slotType: string; value: string }[] = []
) {
	const asked: unknown[] = [];
	const ctx = {
		runQuery: async (ref: unknown) => {
			const name = getFunctionName(ref as Parameters<typeof getFunctionName>[0]);
			if (name.includes('getAskEagernessInternal')) {
				return { mode };
			}
			if (name.includes('getMessage')) {
				return coverage === 'missing'
					? null
					: { contextCoverage: coverage, contactId: 'contact_test' };
			}
			throw new Error(`unexpected runQuery: ${name}`);
		},
		runMutation: async (ref: unknown, args: unknown) => {
			const name = getFunctionName(ref as Parameters<typeof getFunctionName>[0]);
			if (name.includes('recordClarificationAsk')) {
				asked.push(args);
				return undefined;
			}
			// Answer-memory fill lookup — return the configured fills.
			if (name.includes('resolveFills')) {
				return { fills };
			}
			throw new Error(`unexpected runMutation: ${name}`);
		},
	} as unknown as Parameters<typeof clarifyStep.execute>[0];
	return Object.assign(ctx, { asked });
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

describe('clarifyStep.execute — ask-eagerness dial', () => {
	const routineSlot: ReplySlot = {
		slotType: 'factual_lookup',
		question: 'What is our standard turnaround time?',
		answerableFromContext: false,
		decisionRelevant: true,
		options: [],
	};

	/** Slots [high-stakes decision, routine lookup], both divergent. */
	function mockTwoDivergentSlots() {
		mocks.runLlmObject
			.mockResolvedValueOnce({
				object: { slots: [decisionSlot, routineSlot] },
				tokenUsage: undefined,
				modelUsed: 'mock-model',
			})
			.mockResolvedValueOnce({
				object: { divergentSlotIndexes: [0, 1] },
				tokenUsage: undefined,
				modelUsed: 'mock-model',
			});
	}

	it('Off suppresses asking entirely — no LLM calls, no ask logged', async () => {
		const ctx = makeCtx({ lowCoverage: true }, 'off');
		const { output } = await clarifyStep.execute(ctx, makeInput());
		expect(output.resolution).toBe('eagerness_off');
		expect(output.questions).toEqual([]);
		expect(mocks.runLlmObject).not.toHaveBeenCalled();
		expect(mocks.runLlmText).not.toHaveBeenCalled();
		expect(ctx.asked).toHaveLength(0);
	});

	it('Cautious surfaces every divergent slot (raises no bar)', async () => {
		mockTwoDivergentSlots();
		const ctx = makeCtx({ lowCoverage: true }, 'cautious');
		const { output } = await clarifyStep.execute(ctx, makeInput());
		expect(output.resolution).toBe('questions_emitted');
		expect(output.questions).toHaveLength(2);
	});

	it('Confident raises the bar vs Cautious — only high-stakes slots, capped at 1', async () => {
		mockTwoDivergentSlots();
		const ctx = makeCtx({ lowCoverage: true }, 'confident');
		const { output } = await clarifyStep.execute(ctx, makeInput());
		expect(output.questions).toHaveLength(1);
		expect(output.questions[0]!.slotType).toBe('decision'); // routine lookup dropped
	});

	it('enforces the hard per-email cap and batches into one form', async () => {
		// Five divergent high-stakes slots; cautious cap is 3.
		const slots: ReplySlot[] = Array.from({ length: 5 }, (_, i) => ({
			...decisionSlot,
			question: `Decision ${i}?`,
		}));
		mocks.runLlmObject
			.mockResolvedValueOnce({
				object: { slots },
				tokenUsage: undefined,
				modelUsed: 'mock-model',
			})
			.mockResolvedValueOnce({
				object: { divergentSlotIndexes: [0, 1, 2, 3, 4] },
				tokenUsage: undefined,
				modelUsed: 'mock-model',
			});
		const ctx = makeCtx({ lowCoverage: true }, 'cautious');
		const { output } = await clarifyStep.execute(ctx, makeInput());
		// One batch (single array), hard-capped at 3 — never dripped.
		expect(output.questions).toHaveLength(3);
	});

	it('logs the ask with its predicted value + dial position when a question is emitted', async () => {
		mockTwoDivergentSlots();
		const ctx = makeCtx({ lowCoverage: true }, 'confident');
		await clarifyStep.execute(ctx, makeInput());
		expect(ctx.asked).toHaveLength(1);
		const row = ctx.asked[0] as {
			source: string;
			eagerness: string;
			questionCount: number;
			predictedValue: number;
			slotTypes: string[];
		};
		expect(row.source).toBe('agent');
		expect(row.eagerness).toBe('confident');
		expect(row.questionCount).toBe(1);
		expect(row.slotTypes).toEqual(['decision']);
		// A high-stakes decision ask scores the maximum predicted value.
		expect(row.predictedValue).toBeCloseTo(1);
	});
});

describe('clarifyStep.route', () => {
	function outputWith(
		questions: ClarifyOutput['questions'],
		memoryAnswers: ClarifyOutput['memoryAnswers'] = []
	): ClarifyOutput {
		return {
			questions,
			memoryAnswers,
			resolution: questions.length > 0 ? 'questions_emitted' : 'converged',
		};
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

	it('folds memory-filled answers into the parked questions when some remain open', () => {
		const input = makeInput();
		const memoryAnswers: ClarifyOutput['memoryAnswers'] = [
			{
				id: 'clarify_1',
				slotType: 'factual_lookup',
				text: 'Which dock?',
				answer: { value: 'Bay 3', source: 'memory', at: 1 },
			},
		];
		const route = clarifyStep.route(
			outputWith([{ id: 'clarify_0', slotType: 'decision', text: 'Push the date?' }], memoryAnswers),
			input,
			runCtx
		);
		if (route.kind !== 'transition' || route.transition.to !== 'awaiting_clarification') {
			throw new Error('expected awaiting_clarification');
		}
		// The memory-answered question rides along pre-answered; only the open one
		// will be shown to the owner.
		expect(route.transition.questions).toHaveLength(2);
		const dock = route.transition.questions.find((q) => q.id === 'clarify_1');
		expect(dock?.answer?.source).toBe('memory');
	});

	it('threads memory-filled facts into the draft when every slot was resolved silently', () => {
		const input = makeInput();
		const memoryAnswers: ClarifyOutput['memoryAnswers'] = [
			{
				id: 'clarify_0',
				slotType: 'factual_lookup',
				text: 'Which dock?',
				answer: { value: 'Bay 3', source: 'memory', at: 1 },
			},
		];
		const route = clarifyStep.route(outputWith([], memoryAnswers), input, runCtx);
		if (route.kind !== 'transition' || route.transition.to !== 'drafting') {
			throw new Error('expected drafting');
		}
		expect(route.nextStep?.kind).toBe('draft');
		const draftInput = route.nextStep?.input as { confirmedContext?: string };
		expect(draftInput.confirmedContext).toContain('Bay 3');
	});
});

describe('clarifyStep.execute — answer-memory', () => {
	it('fills a would-be question silently from stored memory (no ask, no park)', async () => {
		mocks.runLlmObject
			.mockResolvedValueOnce({
				object: { slots: [decisionSlot] },
				tokenUsage: undefined,
				modelUsed: 'mock-model',
			})
			.mockResolvedValueOnce({
				object: { divergentSlotIndexes: [0] }, // would normally ask
				tokenUsage: undefined,
				modelUsed: 'mock-model',
			});
		// Memory already holds the answer for the emitted question (clarify_0).
		const ctx = makeCtx({ lowCoverage: true }, null, [
			{ questionId: 'clarify_0', slotType: 'decision', value: 'Yes, push to March.' },
		]);
		const { output } = await clarifyStep.execute(ctx, makeInput());
		expect(output.resolution).toBe('memory_filled');
		expect(output.questions).toEqual([]);
		expect(output.memoryAnswers).toHaveLength(1);
		expect(output.memoryAnswers[0]!.answer?.value).toBe('Yes, push to March.');
		expect(output.memoryAnswers[0]!.answer?.source).toBe('memory');
		// It was NOT asked — no ask instrumentation row.
		expect(ctx.asked).toHaveLength(0);
	});
});

describe('buildMemoryConfirmedContext', () => {
	it('renders filled answers as a confirmed-facts block, skipping blanks', () => {
		const block = buildMemoryConfirmedContext([
			{
				id: 'clarify_0',
				slotType: 'factual_lookup',
				text: 'Which dock?',
				answer: { value: 'Bay 3', source: 'memory', at: 1 },
			},
			{ id: 'clarify_1', slotType: 'decision', text: 'Ship it?' }, // unanswered → skipped
		]);
		expect(block).toBe('- Which dock? Bay 3');
	});
});
