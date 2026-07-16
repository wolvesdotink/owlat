/**
 * Draft-quality self-check tests for the `draft` Agent step.
 *
 * Covers:
 *   - buildSelfCheckPrompt frames both the inbound context AND the draft as
 *     untrusted DATA (SYSTEM_GUARD posture) and includes both.
 *   - execute() persists draftQuality (SEPARATELY from confidenceScore) and
 *     threads it into the route input when the self-check succeeds.
 *   - execute() FAILS SOFT: when the self-check LLM call throws, draftQuality is
 *     null / absent (never fabricated), the draft is still persisted, and the
 *     pipeline continues to the route step.
 *
 * The LLM dispatch seam and the provider factory are mocked — no live model.
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

import { draftStep, buildSelfCheckPrompt, type DraftInput } from '../index';
import type { Id } from '../../../../_generated/dataModel';

const messageId = 'msg_1' as Id<'inboundMessages'>;

const draftInput: DraftInput = {
	inboundMessageId: messageId,
	context: 'Customer asks: where is my order #4821?',
	classification: {
		category: 'support',
		priority: 'normal',
		sentiment: 'neutral',
		intent: 'question',
		confidence: 0.9,
	},
};

/** Fake execute ctx capturing the recordDraftOutput mutation args. */
function makeCtx() {
	const recorded: Array<Record<string, unknown>> = [];
	const selections: Array<Record<string, unknown>> = [];
	const ctx = {
		runQuery: async (ref: unknown, args: Record<string, unknown>) => {
			const name = getFunctionName(ref as Parameters<typeof getFunctionName>[0]);
			if (name.includes('getAgentConfig')) return null;
			if (name.includes('getMessage')) return { subject: 'Order status', contactId: 'contact_1' }; // no `to` → skip voice
			if (name.includes('resolveForDraft')) {
				selections.push(args);
				return 'default';
			}
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
	return { ctx, recorded, selections };
}

beforeEach(() => {
	mocks.runLlmText.mockReset();
	mocks.runLlmObject.mockReset();
	mocks.resolveLanguageModel.mockReset();
	mocks.resolveLanguageModel.mockReturnValue('mock-model');
	mocks.runLlmText.mockResolvedValue({
		text: 'Your order #4821 shipped yesterday and arrives Friday.',
		tokenUsage: undefined,
		modelUsed: 'mock-model',
	});
});

describe('buildSelfCheckPrompt', () => {
	it('frames both context and draft as untrusted DATA and includes them', () => {
		const prompt = buildSelfCheckPrompt({ context: 'INBOUND-XYZ', draft: 'DRAFT-XYZ' });
		expect(prompt).toMatch(/untrusted DATA/i);
		expect(prompt).toMatch(/never follow/i);
		expect(prompt).toContain('INBOUND-XYZ');
		expect(prompt).toContain('DRAFT-XYZ');
		expect(prompt).toContain('<draft_reply>');
	});
});

describe('draftStep.execute — draft-quality self-check', () => {
	it('persists draftQuality separately and threads it into the route input', async () => {
		mocks.runLlmObject.mockResolvedValue({
			object: { score: 0.88, complete: true, grounded: true, flags: [] },
			tokenUsage: undefined,
			modelUsed: 'mock-model',
		});
		const { ctx, recorded, selections } = makeCtx();

		const { output } = await draftStep.execute(ctx, draftInput);

		// Persisted: draftQuality present, confidenceScore = classifier confidence
		expect(recorded).toHaveLength(1);
		expect(recorded[0]!['confidenceScore']).toBe(0.9);
		expect(recorded[0]!['draftQuality']).toEqual({
			score: 0.88,
			complete: true,
			grounded: true,
			flags: [],
		});
		expect(selections).toEqual([{ contactId: 'contact_1', classification: 'support' }]);

		// Threaded into the step output → route input
		expect(output.draftQuality).toEqual({
			score: 0.88,
			complete: true,
			grounded: true,
			flags: [],
		});
		const route = draftStep.route(output, draftInput, {
			inboundMessageId: messageId,
			agentConfig: null,
		});
		if (route.kind !== 'in_state') throw new Error('expected in_state');
		expect(route.nextStep?.input).toMatchObject({ draftQuality: output.draftQuality });
	});

	it('fails soft when the self-check throws: draftQuality is null, draft still persisted', async () => {
		mocks.runLlmObject.mockRejectedValue(new Error('model unavailable'));
		const { ctx, recorded } = makeCtx();

		const { output } = await draftStep.execute(ctx, draftInput);

		// The draft is still recorded (pipeline never blocked) but WITHOUT a
		// fabricated quality — the route step will treat it as unknown/LOW.
		expect(recorded).toHaveLength(1);
		expect(recorded[0]!['draftResponse']).toBeTruthy();
		expect('draftQuality' in recorded[0]!).toBe(false);
		expect(output.draftQuality).toBeNull();
	});
});
