/**
 * The `draft` Agent step never stores a draft with `[[...]]` gaps the owner
 * did not agree to (#1343): its gaps go back as questions, a gap no question
 * may ask for leaves the reply to a person, and with consent ("Draft with what
 * I have", or asking turned off) the draft keeps its gaps and every fixed
 * placeholder.
 *
 * The LLM dispatch seam, the provider factory and the question translation
 * are mocked — no live model.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeStepCtx } from '../../__tests__/stepCtx';

const mocks = vi.hoisted(() => ({
	runLlmText: vi.fn(),
	runLlmObject: vi.fn(),
	localizeQuestions: vi.fn(),
}));

vi.mock('../../../../lib/llm/dispatch', () => ({
	runLlmText: mocks.runLlmText,
	runLlmTextWithTools: mocks.runLlmText,
	runLlmObject: mocks.runLlmObject,
}));
vi.mock('../../../../lib/llmProvider', () => ({
	resolveLanguageModel: () => 'mock-model',
	classifiedDraftRouteOf: () => 'capable',
}));
vi.mock('../../../../inbox/clarificationLocalize', () => ({
	localizeQuestions: mocks.localizeQuestions,
}));

import { draftStep, type DraftInput } from '../index';
import { DRAFT_HELD_REASON } from '../gaps';
import type { Id } from '../../../../_generated/dataModel';

const messageId = 'msg_1' as Id<'inboundMessages'>;

const input: DraftInput = {
	inboundMessageId: messageId,
	context: 'Customer asks: when does my order arrive?',
	classification: {
		category: 'support',
		priority: 'normal',
		sentiment: 'neutral',
		intent: 'question',
		confidence: 0.9,
	},
};

const answered = {
	id: 'clarify_0',
	slotType: 'factual_lookup',
	text: 'Which order?',
	answer: { value: '#4821', source: 'user' as const, at: 1 },
};

function makeCtx(message: Record<string, unknown> = {}) {
	const stored: Array<Record<string, unknown>> = [];
	const decisions: Array<Record<string, unknown>> = [];
	const ctx = makeStepCtx<Parameters<typeof draftStep.execute>[0]>({
		queries: {
			getAgentConfig: null,
			getMessage: {
				subject: 'Order status',
				from: 'customer@example.com',
				pendingClarification: { questions: [answered], askedAt: 1 },
				...message,
			},
		},
		mutations: {
			recordDraftOutput: (args) => {
				stored.push(args as Record<string, unknown>);
				return undefined;
			},
			recordAgentDecision: (args) => {
				decisions.push(args as Record<string, unknown>);
				return undefined;
			},
			llmUsage: undefined,
		},
	});
	return { ctx, stored, decisions };
}

function drafts(text: string) {
	mocks.runLlmText.mockResolvedValue({ text, tokenUsage: undefined, modelUsed: 'mock-model' });
}

const runCtx = { inboundMessageId: messageId, agentConfig: null };

beforeEach(() => {
	mocks.runLlmText.mockReset();
	mocks.runLlmObject.mockReset();
	mocks.runLlmObject.mockResolvedValue({
		object: { score: 0.9, complete: true, grounded: true, flags: [] },
		tokenUsage: undefined,
		modelUsed: 'mock-model',
	});
	mocks.localizeQuestions.mockReset();
	mocks.localizeQuestions.mockImplementation(async (_model, questions: { text: string }[]) => ({
		questions: questions.map((q) => ({
			...q,
			translations: [{ locale: 'de', text: `DE ${q.text}` }],
		})),
	}));
});

describe('draftStep — gaps nobody agreed to', () => {
	it('stores no draft and asks one question per gap, keeping the earlier answers', async () => {
		drafts('Order #4821 arrives on [[delivery date]].');
		const { ctx, stored } = makeCtx();

		const { output } = await draftStep.execute(ctx, input);

		expect(stored).toHaveLength(0);
		const route = draftStep.route(output, input, runCtx);
		expect(route).toMatchObject({ kind: 'transition' });
		if (route.kind !== 'transition') throw new Error('expected a transition');
		expect(route.nextStep).toBeUndefined();
		expect(route.transition).toMatchObject({ to: 'awaiting_clarification' });
		if (route.transition.to !== 'awaiting_clarification') throw new Error('wrong target');
		expect(route.transition.questions).toEqual([
			answered,
			{
				id: 'gap_0',
				slotType: 'factual_lookup',
				text: 'delivery date',
				answerKind: 'text',
				translations: [{ locale: 'de', text: 'DE delivery date' }],
			},
		]);
	});

	it('leaves a gap only a password could fill to a person, with no AI draft', async () => {
		drafts('Log in with [[the customer password]] to see it.');
		const { ctx, stored, decisions } = makeCtx();

		const { output } = await draftStep.execute(ctx, input);

		expect(stored).toHaveLength(0);
		expect(decisions).toEqual([expect.objectContaining({ reason: DRAFT_HELD_REASON })]);
		const route = draftStep.route(output, input, runCtx);
		expect(route).toMatchObject({
			kind: 'transition',
			transition: { to: 'draft_ready', draftResponse: '' },
		});
	});

	it('stores a draft without gaps and hands it to the route step', async () => {
		drafts('Order #4821 arrives on Friday.');
		const { ctx, stored } = makeCtx();

		const { output } = await draftStep.execute(ctx, input);

		expect(stored).toHaveLength(1);
		expect(draftStep.route(output, input, runCtx)).toMatchObject({
			kind: 'in_state',
			nextStep: { kind: 'route' },
		});
	});
});

describe('draftStep — the owner agreed to gaps', () => {
	it('stores the draft with its gaps and every fixed placeholder', async () => {
		drafts('Order #4821 arrives on [[delivery date]].');
		const { ctx, stored } = makeCtx();
		const consented = {
			...input,
			isGapsAccepted: true,
			gapPlaceholders: ['[[Gift wrapping]]'],
		};

		const { output } = await draftStep.execute(ctx, consented);

		expect(stored).toHaveLength(1);
		expect(stored[0]!['draftResponse']).toBe(
			'Order #4821 arrives on [[delivery date]].\n\n[[Gift wrapping]]'
		);
		expect(mocks.localizeQuestions).not.toHaveBeenCalled();
		expect(draftStep.route(output, consented, runCtx)).toMatchObject({ kind: 'in_state' });
	});
});

/** What the model was asked, as text. */
const prompt = () => JSON.stringify(mocks.runLlmText.mock.calls[0]?.[0] ?? {});

describe('draftStep — the stored clarification, on every path in', () => {
	// "Draft with what I have", then the draft failed: `retryFailedActions`
	// runs the whole pipeline again and the clarify step hands off with none of
	// the owner's answers, consent or placeholders in the input.
	it('keeps the answers, the consent and the open placeholder on a retry', async () => {
		drafts('Order #4821 is on its way.');
		const { ctx, stored } = makeCtx({
			pendingClarification: {
				questions: [
					answered,
					{ id: 'clarify_1', slotType: 'date_time', text: 'When does it ship?' },
				],
				askedAt: 1,
				answeredAt: 2,
				isGapsAccepted: true,
			},
		});

		const { output } = await draftStep.execute(ctx, input);

		expect(prompt()).toContain('#4821');
		expect(stored).toHaveLength(1);
		// The model left the open detail out: its placeholder is still there, so
		// the draft is gap-guarded and the `draft_gaps` gate keeps it from sending.
		expect(stored[0]!['draftResponse']).toBe('Order #4821 is on its way.\n\n[[When does it ship]]');
		expect(stored[0]!['isGapsAccepted']).toBe(true);
		expect(mocks.localizeQuestions).not.toHaveBeenCalled();
		expect(draftStep.route(output, input, runCtx)).toMatchObject({ kind: 'in_state' });
	});

	it("keeps the owner's file pick instead of searching Files again", async () => {
		const pick = {
			query: 'signed contract',
			ambiguous: false,
			candidates: [
				{
					fileId: 'file_pick',
					storageId: 'store_pick',
					filename: 'contract-signed.pdf',
					mimeType: 'application/pdf',
					fileSize: 2048,
					score: 1,
				},
			],
		};
		drafts('Here is the signed contract.');
		const { ctx, stored } = makeCtx({
			attachmentSuggestions: pick,
			pendingClarification: {
				questions: [
					{
						id: 'clarify_attachment',
						slotType: 'attachment',
						answerKind: 'file',
						text: 'Which file should I attach to this reply?',
						answer: {
							value: 'contract-signed.pdf',
							source: 'user',
							at: 2,
							file: { source: 'semanticFile', id: 'file_pick', filename: 'contract-signed.pdf' },
						},
					},
				],
				askedAt: 1,
				answeredAt: 2,
			},
		});

		await draftStep.execute(ctx, input);

		expect(prompt()).toContain('The file \\"contract-signed.pdf\\" is attached to this reply');
		expect(stored[0]!['attachmentSuggestions']).toEqual(pick);
	});

	it('suggests no file when the owner said it is not ready', async () => {
		drafts('The document will follow once it is ready.');
		const { ctx, stored } = makeCtx({
			pendingClarification: {
				questions: [
					{
						id: 'clarify_attachment',
						slotType: 'attachment',
						answerKind: 'file',
						text: "They asked for a file. I couldn't find it in Files.",
						options: ["It isn't ready yet"],
						answer: { value: "It isn't ready yet", source: 'user', at: 2 },
					},
				],
				askedAt: 1,
				answeredAt: 2,
			},
		});

		await draftStep.execute(ctx, input);

		expect(prompt()).toContain("It isn't ready yet");
		// No search either: the step context has no action route for it.
		expect(stored[0]!['attachmentSuggestions']).toBeUndefined();
	});
});
