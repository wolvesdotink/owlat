/**
 * Ask-the-thread answers are shown, not stored, but an answer that stopped at
 * its output limit is still incomplete: the action returns
 * `isTruncated` so the UI can mark it cut off.
 */

import { describe, it, expect, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ runLlmText: vi.fn() }));

vi.mock('../ai/gate', async (importActual) => ({
	...(await importActual<object>()),
	gateAndLoadThread: vi.fn(async () => ({ messages: [{ id: 'm1' }] })),
}));
vi.mock('../ai/transcript', async (importActual) => ({
	...(await importActual<object>()),
	buildThreadTranscript: vi.fn(async () => 'Them: when do we ship?'),
}));
vi.mock('../../lib/llmProvider', () => ({ resolveLanguageModel: vi.fn(async () => 'mock-model') }));
vi.mock('../../lib/llm/dispatch', async () => {
	const { metered } = await import('../../analytics/__tests__/meteredDispatch.testlib');
	return { runLlmText: metered((opts: unknown) => mocks.runLlmText(opts)) };
});

import { askThread } from '../ai/assist';

type Handler = (ctx: unknown, args: unknown) => Promise<{ answer: string; isTruncated: boolean }>;
const handler = (askThread as unknown as { _handler: Handler })._handler;

function ctx() {
	return {
		runQuery: vi.fn(async () => null),
		runMutation: vi.fn(async () => null),
		scheduler: { runAfter: vi.fn(async () => null) },
	};
}

describe('askThread — an answer cut off at its output limit', () => {
	it('says so instead of passing it off as complete', async () => {
		mocks.runLlmText.mockResolvedValueOnce({
			text: 'We ship on',
			tokenUsage: undefined,
			modelUsed: 'mock-model',
			isTruncated: true,
		});
		const cut = await handler(ctx(), { messageId: 'm1', question: 'When do we ship?' });
		expect(cut).toEqual({ answer: 'We ship on', isTruncated: true });

		mocks.runLlmText.mockResolvedValueOnce({
			text: 'We ship on Friday.',
			tokenUsage: undefined,
			modelUsed: 'mock-model',
			isTruncated: false,
		});
		const whole = await handler(ctx(), { messageId: 'm1', question: 'When do we ship?' });
		expect(whole).toEqual({ answer: 'We ship on Friday.', isTruncated: false });
	});
});
