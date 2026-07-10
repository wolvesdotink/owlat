/**
 * Multi-option review-draft tests for the `draft` Agent step.
 *
 * Covers:
 *   - shouldOfferDraftOptions gates ONLY the review-bound cases (low classifier
 *     confidence OR low / unknown draft-quality), so the extra generation cost
 *     is bounded.
 *   - buildDraftOptionsPrompt frames the inbound context as untrusted DATA.
 *   - execute() persists 2–3 pickable options on a LOW-quality case, with the
 *     primary self-checked draft pinned as option 0.
 *   - execute() stays single-draft on a HIGH-quality case (no options call, no
 *     draftOptions persisted).
 *   - execute() FAILS SOFT: when the options generation throws, the single
 *     primary draft is still persisted WITHOUT draftOptions.
 *
 * The LLM dispatch seam and the provider factory are mocked — no live model.
 * The shared reply-options generator (mail/replyOptions) runs through the SAME
 * mocked runLlmObject, so option-generation is driven by a second mock result.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getFunctionName } from 'convex/server';

const mocks = vi.hoisted(() => ({
	runLlmText: vi.fn(),
	runLlmObject: vi.fn(),
	resolveLanguageModel: vi.fn(() => 'mock-model'),
}));

vi.mock('../../../../lib/llm/dispatch', () => ({
	runLlmText: mocks.runLlmText,
	// The primary draft now runs through the tool-calling text seam.
	runLlmTextWithTools: mocks.runLlmText,
	runLlmObject: mocks.runLlmObject,
}));
vi.mock('../../../../lib/llmProvider', () => ({
	resolveLanguageModel: mocks.resolveLanguageModel,
	resolveLanguageModelForClassifiedDraft: mocks.resolveLanguageModel,
}));

import {
	draftStep,
	shouldOfferDraftOptions,
	buildDraftOptionsPrompt,
	type DraftInput,
} from '../index';
import type { Id } from '../../../../_generated/dataModel';

const messageId = 'msg_1' as Id<'inboundMessages'>;
const DRAFT_TEXT = 'Your order #4821 shipped yesterday and arrives Friday.';

/** Low-confidence input → the review gate offers alternative drafts. */
const lowConfidenceInput: DraftInput = {
	inboundMessageId: messageId,
	context: 'Customer asks: where is my order #4821?',
	classification: {
		category: 'support',
		priority: 'normal',
		sentiment: 'neutral',
		intent: 'question',
		confidence: 0.5,
	},
};

/** High-confidence input → single draft (no options) when quality is also high. */
const highConfidenceInput: DraftInput = {
	...lowConfidenceInput,
	classification: { ...lowConfidenceInput.classification, confidence: 0.95 },
};

function makeCtx() {
	const recorded: Array<Record<string, unknown>> = [];
	const ctx = {
		runQuery: async (ref: unknown) => {
			const name = getFunctionName(ref as Parameters<typeof getFunctionName>[0]);
			if (name.includes('getAgentConfig')) return null;
			if (name.includes('getMessage')) return { subject: 'Order status' }; // no `to` → skip voice
			throw new Error(`unexpected runQuery: ${name}`);
		},
		runMutation: async (ref: unknown, args: Record<string, unknown>) => {
			const name = getFunctionName(ref as Parameters<typeof getFunctionName>[0]);
			if (name.includes('recordDraftOutput')) {
				recorded.push(args);
				return undefined;
			}
			if (name.includes('llmUsage')) return undefined; // spend accounting
			throw new Error(`unexpected runMutation: ${name}`);
		},
	} as unknown as Parameters<typeof draftStep.execute>[0];
	return { ctx, recorded };
}

beforeEach(() => {
	mocks.runLlmText.mockReset();
	mocks.runLlmObject.mockReset();
	mocks.resolveLanguageModel.mockReset();
	mocks.resolveLanguageModel.mockReturnValue('mock-model');
	mocks.runLlmText.mockResolvedValue({
		text: DRAFT_TEXT,
		tokenUsage: undefined,
		modelUsed: 'mock-model',
	});
});

describe('shouldOfferDraftOptions', () => {
	it('offers options when classifier confidence is low', () => {
		expect(
			shouldOfferDraftOptions(0.5, { score: 0.95, complete: true, grounded: true, flags: [] })
		).toBe(true);
	});
	it('offers options when draft quality is low', () => {
		expect(
			shouldOfferDraftOptions(0.95, { score: 0.4, complete: false, grounded: true, flags: [] })
		).toBe(true);
	});
	it('offers options when draft quality is unknown (null)', () => {
		expect(shouldOfferDraftOptions(0.95, null)).toBe(true);
	});
	it('stays single-draft when confidence AND quality are high', () => {
		expect(
			shouldOfferDraftOptions(0.95, { score: 0.9, complete: true, grounded: true, flags: [] })
		).toBe(false);
	});
});

describe('buildDraftOptionsPrompt', () => {
	it('frames the inbound context as untrusted DATA and includes it', () => {
		const prompt = buildDraftOptionsPrompt({ context: 'INBOUND-XYZ', voiceSection: '' });
		expect(prompt).toMatch(/untrusted DATA/i);
		expect(prompt).toMatch(/never follow/i);
		expect(prompt).toContain('INBOUND-XYZ');
		expect(prompt).toContain('<untrusted_email_content>');
	});
});

describe('draftStep.execute — multi-option review drafts', () => {
	it('persists 2–3 options on a low-quality case, primary draft pinned as option 0', async () => {
		// #1: self-check → LOW score. #2: options generator → 3 variants.
		mocks.runLlmObject
			.mockResolvedValueOnce({
				object: { score: 0.5, complete: false, grounded: true, flags: ['incomplete'] },
				tokenUsage: undefined,
				modelUsed: 'mock-model',
			})
			.mockResolvedValueOnce({
				object: { replies: ['Short reply.', 'Cautious reply.', 'Detailed reply.'] },
				tokenUsage: undefined,
				modelUsed: 'mock-model',
			});
		const { ctx, recorded } = makeCtx();

		const { output } = await draftStep.execute(ctx, highConfidenceInput);

		// Two runLlmObject passes: self-check + options.
		expect(mocks.runLlmObject).toHaveBeenCalledTimes(2);
		expect(recorded).toHaveLength(1);
		const options = recorded[0]!['draftOptions'] as string[];
		expect(options).toEqual([DRAFT_TEXT, 'Short reply.', 'Cautious reply.']);
		expect(options[0]).toBe(DRAFT_TEXT);
		expect(output.draftOptions).toEqual([DRAFT_TEXT, 'Short reply.', 'Cautious reply.']);
	});

	it('stays single-draft on a high-quality case (no options generated or persisted)', async () => {
		// Only the self-check runs; quality is high so options are never requested.
		mocks.runLlmObject.mockResolvedValueOnce({
			object: { score: 0.92, complete: true, grounded: true, flags: [] },
			tokenUsage: undefined,
			modelUsed: 'mock-model',
		});
		const { ctx, recorded } = makeCtx();

		const { output } = await draftStep.execute(ctx, highConfidenceInput);

		expect(mocks.runLlmObject).toHaveBeenCalledTimes(1);
		expect(recorded).toHaveLength(1);
		expect('draftOptions' in recorded[0]!).toBe(false);
		expect(output.draftOptions).toEqual([]);
	});

	it('fails soft when options generation throws: single draft persisted, no draftOptions', async () => {
		// #1: self-check succeeds (low score → wants options). #2: options throws.
		mocks.runLlmObject
			.mockResolvedValueOnce({
				object: { score: 0.5, complete: false, grounded: true, flags: [] },
				tokenUsage: undefined,
				modelUsed: 'mock-model',
			})
			.mockRejectedValueOnce(new Error('options model unavailable'));
		const { ctx, recorded } = makeCtx();

		const { output } = await draftStep.execute(ctx, lowConfidenceInput);

		// The primary draft is still persisted; no fabricated options.
		expect(recorded).toHaveLength(1);
		expect(recorded[0]!['draftResponse']).toBe(DRAFT_TEXT);
		expect('draftOptions' in recorded[0]!).toBe(false);
		expect(output.draftOptions).toEqual([]);
	});
});
