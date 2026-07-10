/**
 * `draftStep.execute` voice-profile personalization.
 *
 * The autonomous draft step injects the recipient's learned writing-voice
 * guidance (mail/voiceProfile.getGuidanceForRecipient) into its system prompt
 * when a profile resolves, and degrades to exactly today's generic org tone
 * when it does not — including when the accessor throws. The LLM dispatch seam
 * and the provider selector are mocked so we can assert the assembled system
 * prompt without a real model call.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getFunctionName } from 'convex/server';
import type { Id } from '../../../../_generated/dataModel';

// Capture the messages passed to the model + return a fixed draft body.
const runLlmTextMock = vi.fn(async (_args: unknown) => ({
	text: 'Thanks — happy to help.',
	tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
	modelUsed: 'test-model',
}));

vi.mock('../../../../lib/llm/dispatch', () => ({
	runLlmText: (args: unknown) => runLlmTextMock(args as never),
	// The primary draft now runs through the tool-calling text seam; alias it to
	// the same capture so the assembled `messages` are still inspected here.
	runLlmTextWithTools: (args: unknown) => runLlmTextMock(args as never),
}));
vi.mock('../../../../lib/llmProvider', () => ({
	resolveLanguageModel: () => ({}) as never,
	resolveLanguageModelForClassifiedDraft: () => ({}) as never,
}));

// Import AFTER mocks are registered.
import { draftStep } from '../index';

const messageId = 'msg_test' as Id<'inboundMessages'>;

const input = {
	inboundMessageId: messageId,
	context: 'Hi there, can you confirm my order shipped?',
	classification: {
		category: 'support',
		priority: 'normal',
		sentiment: 'neutral',
		intent: 'question',
		confidence: 0.9,
	},
};

type GuidanceResult = { guidance: string | null } | (() => never);

function makeCtx(opts: {
	message: { to?: string; subject?: string } | null;
	guidance: GuidanceResult;
}) {
	return {
		runQuery: async (ref: unknown) => {
			const name = getFunctionName(ref as Parameters<typeof getFunctionName>[0]);
			if (name.includes('getAgentConfig')) return null;
			if (name.includes('getMessage')) return opts.message;
			throw new Error(`unexpected runQuery: ${name}`);
		},
		runMutation: async (ref: unknown) => {
			const name = getFunctionName(ref as Parameters<typeof getFunctionName>[0]);
			if (name.includes('getGuidanceForRecipient')) {
				if (typeof opts.guidance === 'function') return opts.guidance();
				return opts.guidance;
			}
			if (name.includes('recordDraftOutput')) return null;
			throw new Error(`unexpected runMutation: ${name}`);
		},
	} as unknown as Parameters<typeof draftStep.execute>[0];
}

/** The system prompt string handed to the model on the last call. */
function lastSystemPrompt(): string {
	const calls = runLlmTextMock.mock.calls;
	const call = calls[calls.length - 1]?.[0] as
		| { messages: Array<{ role: string; content: string }> }
		| undefined;
	const sys = call?.messages.find((m) => m.role === 'system');
	return sys?.content ?? '';
}

const VOICE_BLOCK =
	"Match this user's personal writing voice (learned from their own sent mail):\n" +
	'- Typical sign-offs: Cheers\n' +
	'- Formality: 2/5 (1=very casual, 5=very formal)\n' +
	'- Brevity: 2/5 (1=terse, 5=elaborate)\n' +
	'- Emoji: does not use emoji\n' +
	'Write in this voice while staying appropriate to the thread.';

describe('draftStep.execute — voice personalization', () => {
	beforeEach(() => runLlmTextMock.mockClear());

	it('injects the voice-guidance section when a profile resolves', async () => {
		const ctx = makeCtx({
			message: { to: 'me@hl.camp', subject: 'Order status' },
			guidance: { guidance: VOICE_BLOCK },
		});
		const { output } = await draftStep.execute(ctx, input);
		expect(output.draftSubject).toBe('Re: Order status');
		expect(lastSystemPrompt()).toContain(VOICE_BLOCK);
	});

	it('omits the voice section cleanly when no profile resolves', async () => {
		const ctx = makeCtx({
			message: { to: 'me@hl.camp', subject: 'Order status' },
			guidance: { guidance: null },
		});
		await draftStep.execute(ctx, input);
		const prompt = lastSystemPrompt();
		expect(prompt).not.toContain('personal writing voice');
		// Generic org tone fallback is still present.
		expect(prompt).toContain('Professional and helpful');
	});

	it('degrades to the generic prompt when the accessor throws (no crash)', async () => {
		const ctx = makeCtx({
			message: { to: 'me@hl.camp', subject: 'Order status' },
			guidance: () => {
				throw new Error('accessor boom');
			},
		});
		const { output } = await draftStep.execute(ctx, input);
		expect(output.draftResponse).toBe('Thanks — happy to help.');
		const prompt = lastSystemPrompt();
		expect(prompt).not.toContain('personal writing voice');
		expect(prompt).toContain('Professional and helpful');
	});

	it('omits the voice section when the inbound message has no recipient', async () => {
		const ctx = makeCtx({
			message: { subject: 'Order status' },
			guidance: { guidance: VOICE_BLOCK },
		});
		await draftStep.execute(ctx, input);
		expect(lastSystemPrompt()).not.toContain('personal writing voice');
	});
});
