/**
 * The Reply Queue starter draft (`draftClarificationReply`) through the REAL
 * shared draft service when the model types its tool call as text (#1254): a
 * leading markup prefix is cut before the card stores the draft; markup inside
 * the reply gets one retry without tools, and when that is markup too nothing
 * is stored. Only the model dispatch and the recall tool are mocked.
 */

import { getFunctionName } from 'convex/server';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as AskEagerness from '../../inbox/askEagerness';

const mocks = vi.hoisted(() => ({
	runLlmTextWithTools: vi.fn(),
	runLlmText: vi.fn(),
	runLlmObject: vi.fn(),
}));

vi.mock('../../lib/llm/dispatch', () => ({
	runLlmTextWithTools: mocks.runLlmTextWithTools,
	runLlmText: mocks.runLlmText,
	runLlmObject: mocks.runLlmObject,
}));
vi.mock('../../agent/steps/draft/recall', () => ({
	MAX_RECALL_CALLS: 3,
	buildRecallKnowledgeTool: vi.fn(() => ({ tool: 'recallKnowledge' })),
}));
vi.mock('../../lib/llmProvider', () => ({ resolveLanguageModel: vi.fn(async () => 'mock-model') }));
vi.mock('../../analytics/llmUsage', () => ({ recordLlmSpend: vi.fn(async () => {}) }));
vi.mock('../ai/voiceGuidance', () => ({
	loadVoiceGuidance: vi.fn(async () => null),
	formatVoiceSection: vi.fn(() => ''),
}));
vi.mock('../../inbox/askEagerness', async (importActual) => ({
	...(await importActual<typeof AskEagerness>()),
	shouldSampleDraftDelta: () => false,
}));

import { draftClarificationReply } from '../ai/needsReplyDraft';
import type { Id } from '../../_generated/dataModel';

const threadId = 'thread_1' as Id<'mailThreads'>;
const REPLY = 'Hi John,\n\nThanks for getting in touch. The room is yours.\n\nBest,\nAda';
const MARKUP =
	'<invoke name="recallKnowledge">\n' +
	'<parameter name="query">availability 14-16 December 2026 for 2 guests</parameter>\n' +
	'</invoke>\n\n' +
	'<function_results>\n{"results":[]}\n</function_results>';

function text(value: string) {
	return { text: value, tokenUsage: undefined, modelUsed: 'mock-model' };
}

function makeCtx() {
	const mutations: { name: string; args: Record<string, unknown> }[] = [];
	const ctx = {
		runQuery: vi.fn(async (ref: unknown) => {
			const name = getFunctionName(ref as Parameters<typeof getFunctionName>[0]);
			if (name.includes('getClarificationContext')) {
				return {
					mailboxId: 'mailbox_1',
					latestMessageId: 'msg_1',
					ownerAddress: 'ada@example.com',
					contactId: 'contact_1',
					transcript: 'Them: is a room free from 14 to 16 December for two?',
					answers: [{ question: 'Is a room free?', answer: 'Yes' }],
					fileNotes: '',
					fileGaps: [],
					questionGaps: [],
					answeredSlotTypes: ['factual_lookup'],
				};
			}
			// The strategy selection read: no plugin strategy, the default runs.
			throw new Error(`unexpected runQuery: ${name}`);
		}),
		runMutation: vi.fn(async (ref: unknown, args: Record<string, unknown>) => {
			mutations.push({ name: getFunctionName(ref as Parameters<typeof getFunctionName>[0]), args });
			return undefined;
		}),
		runAction: vi.fn(),
	};
	return { ctx: ctx as unknown as Parameters<typeof draftClarificationReply>[0], mutations };
}

const storedDraft = (mutations: ReturnType<typeof makeCtx>['mutations']) =>
	mutations.find((m) => m.name.includes('persistClarificationDraft'))?.args['draft'];

beforeEach(() => {
	mocks.runLlmTextWithTools.mockReset();
	mocks.runLlmText.mockReset();
	mocks.runLlmObject.mockReset();
	mocks.runLlmObject.mockResolvedValue({
		object: { score: 0.8, complete: true, grounded: true, flags: [] },
		tokenUsage: undefined,
		modelUsed: 'mock-model',
	});
});

describe('draftClarificationReply — leaked tool-call markup', () => {
	it('stores the reply without the markup prefix the model typed above it', async () => {
		mocks.runLlmTextWithTools.mockResolvedValueOnce(text(MARKUP + REPLY));
		const { ctx, mutations } = makeCtx();
		await draftClarificationReply(ctx, { threadId });
		expect(storedDraft(mutations)).toBe(REPLY);
		expect(mocks.runLlmText).not.toHaveBeenCalled();
	});

	it('retries without tools when markup sits inside the reply, and stores the retry', async () => {
		mocks.runLlmTextWithTools.mockResolvedValueOnce(text(`Let me check.\n\n${MARKUP}${REPLY}`));
		mocks.runLlmText.mockResolvedValueOnce(text(REPLY));
		const { ctx, mutations } = makeCtx();
		await draftClarificationReply(ctx, { threadId });
		expect(mocks.runLlmText).toHaveBeenCalledTimes(1);
		expect(storedDraft(mutations)).toBe(REPLY);
	});

	it('stores nothing when the retry is markup as well', async () => {
		mocks.runLlmTextWithTools.mockResolvedValueOnce(text(`Hi John,\n\n${MARKUP}\nBest`));
		mocks.runLlmText.mockResolvedValueOnce(text(`${MARKUP}\n<invoke name="recallKnowledge">`));
		const { ctx, mutations } = makeCtx();
		await draftClarificationReply(ctx, { threadId });
		expect(storedDraft(mutations)).toBeUndefined();
		expect(JSON.stringify(mutations)).not.toContain('<invoke');
	});
});
