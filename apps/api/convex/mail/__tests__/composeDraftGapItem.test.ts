/**
 * Answer mode's gap check keeps a file question's link to the thread item it
 * fills (review F15): the attachment slot's `itemRef` survives into the file
 * question built for it.
 */
import { describe, expect, it, vi } from 'vitest';

const runLlmObject = vi.fn();
vi.mock('../../lib/llm/dispatch', () => ({
	runLlmObject: (a: unknown) => runLlmObject(a),
	runLlmText: vi.fn(),
}));
vi.mock('../../lib/llmProvider', () => ({ resolveLanguageModel: () => 'model' }));
vi.mock('../../analytics/llmUsage', () => ({ recordLlmSpend: vi.fn(async () => {}) }));
vi.mock('../../inbox/attachmentSuggest', () => ({ searchFilesForRequest: vi.fn(async () => []) }));

const { runGapCheck } = await import('../ai/composeDraftGap');

describe('runGapCheck: the file question names its item', () => {
	it('carries the attachment slot’s item onto the file question', async () => {
		runLlmObject.mockResolvedValueOnce({
			object: {
				slots: [
					{
						slotType: 'attachment',
						question: 'Which contract?',
						answerableFromContext: false,
						decisionRelevant: true,
						options: [],
						itemRef: 'i1',
					},
				],
			},
			tokenUsage: undefined,
			modelUsed: 'model',
		});
		const ctx = {
			runMutation: vi.fn(async () => ({ fills: [] })),
			runQuery: vi.fn(),
			runAction: vi.fn(),
		};
		const result = await runGapCheck(ctx as never, {
			context: 'Please send the signed contract.',
			triggerText: 'Please send the signed contract.',
			subject: 'Contract',
			locale: 'en',
			slotItems: [{ ref: 'i1', itemId: 'item_contract' as never, text: 'Send the contract' }],
		});
		const file = result.questions.find((q) => q.answerKind === 'file');
		expect(file).toMatchObject({ itemId: 'item_contract' });
	});
});
