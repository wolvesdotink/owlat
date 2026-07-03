/**
 * Tests for the Postbox-native clarification loop.
 *
 * Covers:
 *   - sanitizeClarificationQuestions (shared safety filter): credential/OTP
 *     solicitations are dropped and every survivor is attributed to its sender.
 *   - refineClarification: emits a clarification when a decision-relevant slot
 *     is genuinely ambiguous (candidates diverge); returns undefined when the
 *     candidates converge, when nothing is a candidate, and when the only
 *     candidate is a credential solicitation.
 *
 * The LLM dispatch seam + provider factory are mocked — no live model. Spend
 * recording no-ops because the mocks return undefined token usage.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
	runLlmText: vi.fn(),
	runLlmObject: vi.fn(),
	getLLMProvider: vi.fn(() => 'mock-model'),
}));

vi.mock('../../lib/llm/dispatch', () => ({
	runLlmText: mocks.runLlmText,
	runLlmObject: mocks.runLlmObject,
}));
vi.mock('../../lib/llmProvider', () => ({
	getLLMProvider: mocks.getLLMProvider,
}));

import {
	sanitizeClarificationQuestions,
	isCredentialSolicitation,
} from '../../inbox/clarificationSlots';
import { refineClarification } from '../needsReplyClassify';

// recordLlmSpend short-circuits on undefined tokenUsage, so ctx is never read.
const ctx = {} as never;
const opts = { transcript: 'Customer: can you approve the refund?', fromAddress: 'ann@acme.com' };

function objectResult(object: unknown) {
	return { object, tokenUsage: undefined, modelUsed: 'mock-model' };
}
function textResult(text: string) {
	return { text, tokenUsage: undefined, modelUsed: 'mock-model' };
}

const decisionSlot = {
	slotType: 'decision' as const,
	question: 'Should we approve the refund?',
	answerableFromContext: false,
	decisionRelevant: true,
	options: ['Yes', 'No'],
};

beforeEach(() => {
	mocks.runLlmText.mockReset();
	mocks.runLlmObject.mockReset();
	mocks.getLLMProvider.mockReset();
	mocks.getLLMProvider.mockReturnValue('mock-model');
	// Three distinct candidate replies by default (so divergence can be judged).
	mocks.runLlmText
		.mockResolvedValueOnce(textResult('Yes, approving the refund now.'))
		.mockResolvedValueOnce(textResult('No, this is outside our policy.'))
		.mockResolvedValueOnce(textResult('Let me check with the team first.'));
});

describe('sanitizeClarificationQuestions', () => {
	it('drops credential / OTP solicitations and attributes survivors', () => {
		const out = sanitizeClarificationQuestions(
			[
				{ slotType: 'decision', text: 'Should we approve the refund?', options: ['Yes', 'No'] },
				{ slotType: 'factual_lookup', text: 'What is your account password?' },
				{ slotType: 'factual_lookup', text: 'Please share the one-time code you received.' },
			],
			'ann@acme.com',
		);
		expect(out).toHaveLength(1);
		expect(out[0]!.text).toBe('Should we approve the refund?');
		expect(out[0]!.id).toBe('clarify_0');
		expect(out[0]!.options).toEqual(['Yes', 'No']);
		expect(out[0]!.attribution).toContain('acme.com');
		expect(out[0]!.attribution).toMatch(/never ask for your password/i);
	});

	it('flags credential-shaped text', () => {
		expect(isCredentialSolicitation('enter your OTP')).toBe(true);
		expect(isCredentialSolicitation('what is your CVV')).toBe(true);
		expect(isCredentialSolicitation('which date works for the call?')).toBe(false);
	});
});

describe('refineClarification', () => {
	it('emits a clarification when a decision-relevant slot is ambiguous', async () => {
		mocks.runLlmObject
			.mockResolvedValueOnce(objectResult({ slots: [decisionSlot] })) // slot extraction
			.mockResolvedValueOnce(objectResult({ divergentSlotIndexes: [0] })); // divergence

		const result = await refineClarification(ctx, opts);
		expect(result).toBeDefined();
		expect(result!.isNeeded).toBe(true);
		expect(result!.questions).toHaveLength(1);
		expect(result!.questions[0]!.text).toBe('Should we approve the refund?');
		expect(result!.questions[0]!.options).toEqual(['Yes', 'No']);
		expect(result!.questions[0]!.attribution).toContain('acme.com');
		// The divergence stage was actually reached (3 candidate samples).
		expect(mocks.runLlmText).toHaveBeenCalledTimes(3);
	});

	it('returns undefined when the candidates converge (no real question)', async () => {
		mocks.runLlmObject
			.mockResolvedValueOnce(objectResult({ slots: [decisionSlot] }))
			.mockResolvedValueOnce(objectResult({ divergentSlotIndexes: [] }));
		expect(await refineClarification(ctx, opts)).toBeUndefined();
	});

	it('returns undefined and skips the divergence stage when nothing is a candidate', async () => {
		mocks.runLlmObject.mockResolvedValueOnce(
			objectResult({
				slots: [{ ...decisionSlot, answerableFromContext: true }],
			}),
		);
		expect(await refineClarification(ctx, opts)).toBeUndefined();
		expect(mocks.runLlmText).not.toHaveBeenCalled();
	});

	it('drops a credential-solicitation candidate slot even when it diverges', async () => {
		mocks.runLlmObject
			.mockResolvedValueOnce(
				objectResult({
					slots: [
						{
							slotType: 'factual_lookup',
							question: 'What is your account password?',
							answerableFromContext: false,
							decisionRelevant: true,
						},
					],
				}),
			)
			.mockResolvedValueOnce(objectResult({ divergentSlotIndexes: [0] }));
		expect(await refineClarification(ctx, opts)).toBeUndefined();
	});

	it('fails soft to undefined when the model throws', async () => {
		mocks.runLlmObject.mockRejectedValueOnce(new Error('provider down'));
		expect(await refineClarification(ctx, opts)).toBeUndefined();
	});
});
