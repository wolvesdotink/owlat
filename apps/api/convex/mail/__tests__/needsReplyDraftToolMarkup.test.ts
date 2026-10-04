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
	sampleDelta: false,
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
	shouldSampleDraftDelta: () => mocks.sampleDelta,
}));

import { draftClarificationReply } from '../ai/needsReplyDraft';
import { recordLlmSpend } from '../../analytics/llmUsage';
import { LlmPartialUsageError } from '../../lib/llm/partialUsage';
import type { Id } from '../../_generated/dataModel';

const threadId = 'thread_1' as Id<'mailThreads'>;
const REPLY = 'Hi John,\n\nThanks for getting in touch. The room is yours.\n\nBest,\nAda';
const MARKUP =
	'<invoke name="recallKnowledge">\n' +
	'<parameter name="query">availability 14-16 December 2026 for 2 guests</parameter>\n' +
	'</invoke>\n\n' +
	'<function_results>\n{"results":[]}\n</function_results>';

function text(value: string, tokens?: number) {
	return {
		text: value,
		tokenUsage:
			tokens === undefined
				? undefined
				: { promptTokens: tokens, completionTokens: tokens, totalTokens: 2 * tokens },
		modelUsed: 'mock-model',
	};
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
	vi.mocked(recordLlmSpend).mockClear();
	mocks.sampleDelta = false;
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

	it('retries a draft cut off inside a tool tag, and stores the retry', async () => {
		mocks.runLlmTextWithTools.mockResolvedValueOnce(
			text('Hi John,\n<invoke name="recallKnowledge"')
		);
		mocks.runLlmText.mockResolvedValueOnce(text(REPLY));
		const { ctx, mutations } = makeCtx();
		await draftClarificationReply(ctx, { threadId });
		expect(storedDraft(mutations)).toBe(REPLY);
	});

	it('records the spend of both rejected generations', async () => {
		mocks.runLlmTextWithTools.mockResolvedValueOnce(text(`Hi John,\n\n${MARKUP}\nBest`, 10));
		mocks.runLlmText.mockResolvedValueOnce(text(MARKUP, 4));
		const { ctx } = makeCtx();
		await draftClarificationReply(ctx, { threadId });
		const draftRows = vi
			.mocked(recordLlmSpend)
			.mock.calls.filter(([, label]) => label === 'postbox_clarify_draft');
		expect(draftRows.map(([, , usage]) => usage?.totalTokens)).toEqual([20, 8]);
	});

	it('measures the comparison draft without its markup prefix', async () => {
		mocks.sampleDelta = true;
		mocks.runLlmTextWithTools.mockResolvedValueOnce(text(REPLY));
		mocks.runLlmText.mockResolvedValueOnce(text(MARKUP + REPLY));
		const { ctx, mutations } = makeCtx();
		await draftClarificationReply(ctx, { threadId });
		const logged = mutations.find((m) => m.name.includes('recordClarificationAsk'))?.args;
		expect(logged).toMatchObject({ isDraftChanged: false, draftDivergence: 0 });
	});

	it('logs no comparison when the comparison draft is markup', async () => {
		mocks.sampleDelta = true;
		mocks.runLlmTextWithTools.mockResolvedValueOnce(text(REPLY));
		mocks.runLlmText.mockResolvedValueOnce(text(`Hi,\n${MARKUP}`));
		const { ctx, mutations } = makeCtx();
		await draftClarificationReply(ctx, { threadId });
		const logged = mutations.find((m) => m.name.includes('recordClarificationAsk'))?.args;
		expect(logged).toBeDefined();
		expect(logged?.['isDraftChanged']).toBeUndefined();
		expect(logged?.['draftDivergence']).toBeUndefined();
	});

	it.each([
		'Let me check `availability. <tool_call>{"name":"recallKnowledge","arguments":{"query":"`December dates"}}</tool_call>',
		'Let me check `availability. <tool_call>{"name":"recallKnowledge","arguments":{"query":"`December dates"}}',
		'Let me check `availability. <tool_call>{"name":"recallKnowledge","arguments":{"query":"`December` dates"}}</tool_call>Hi John`',
	])('stores the retry, never a backtick-wrapped call: %s', async (leak) => {
		mocks.runLlmTextWithTools.mockResolvedValueOnce(text(`${leak}\n${REPLY}`));
		mocks.runLlmText.mockResolvedValueOnce(text(REPLY));
		const { ctx, mutations } = makeCtx();
		await draftClarificationReply(ctx, { threadId });
		expect(storedDraft(mutations)).toBe(REPLY);
	});

	it('stores nothing when the retry carries a backtick-wrapped call as well', async () => {
		const leak =
			'Let me check `availability. <tool_call>{"name":"recallKnowledge","arguments":{"query":"`December dates"}}';
		mocks.runLlmTextWithTools.mockResolvedValueOnce(text(leak));
		mocks.runLlmText.mockResolvedValueOnce(text(leak));
		const { ctx, mutations } = makeCtx();
		await draftClarificationReply(ctx, { threadId });
		expect(storedDraft(mutations)).toBeUndefined();
	});
});

describe('draftClarificationReply — the draft spend, recorded once (#1256)', () => {
	const draftRows = () =>
		vi.mocked(recordLlmSpend).mock.calls.filter(([, label]) => label === 'postbox_clarify_draft');

	it('records the paid tool steps of a draft that fails partway', async () => {
		const usage = { promptTokens: 6, completionTokens: 3, totalTokens: 9 };
		mocks.runLlmTextWithTools.mockRejectedValueOnce(
			new LlmPartialUsageError(new Error('provider down'), usage, 'mock-model')
		);
		const { ctx, mutations } = makeCtx();
		await draftClarificationReply(ctx, { threadId });
		expect(storedDraft(mutations)).toBeUndefined();
		expect(draftRows()).toEqual([[ctx, 'postbox_clarify_draft', usage, 'mock-model']]);
	});

	it('records a successful draft exactly once', async () => {
		mocks.runLlmTextWithTools.mockResolvedValueOnce(text(REPLY, 5));
		const { ctx, mutations } = makeCtx();
		await draftClarificationReply(ctx, { threadId });
		expect(storedDraft(mutations)).toBe(REPLY);
		expect(draftRows().map(([, , usage]) => usage?.totalTokens)).toEqual([10]);
	});
});
