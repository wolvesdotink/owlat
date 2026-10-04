/**
 * Answer mode's draft writer (`writeAnswerDraft`, mail/ai/composeDraftWrite.ts)
 * when the model types its tool call as text, or narrates before a real one
 * (#1254). Every write to the owner's stream buffer is recorded, so the tests
 * pin both what the editor is shown while the model writes and what the draft
 * is finalized as. The model is scripted; the buffer and session writes are a
 * fake ctx.
 */

import { getFunctionName } from 'convex/server';
import { tool } from 'ai';
import { z } from 'zod';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as DispatchModule from '../../lib/llm/dispatch';
import { scriptedStreamModel } from '../../lib/llm/__tests__/streamModel.testlib';

const mocks = vi.hoisted(() => ({
	model: undefined as unknown,
	runLlmStream: vi.fn(),
	actualRunLlmStream: undefined as unknown as typeof DispatchModule.runLlmStream,
	recallExecute: vi.fn(async () => ({ facts: [] as string[] })),
}));

vi.mock('../../lib/llm/dispatch', async (importActual) => {
	const actual = await importActual<typeof DispatchModule>();
	mocks.actualRunLlmStream = actual.runLlmStream;
	return { ...actual, runLlmStream: mocks.runLlmStream };
});
vi.mock('../../lib/llmProvider', () => ({ resolveLanguageModel: vi.fn(async () => mocks.model) }));
vi.mock('../../analytics/llmUsage', () => ({ recordLlmSpend: vi.fn(async () => {}) }));
vi.mock('../../agent/steps/draft/recall', () => ({
	MAX_RECALL_CALLS: 3,
	buildRecallKnowledgeTool: () =>
		tool({
			description: 'Fetch a fact',
			inputSchema: z.object({ query: z.string() }),
			execute: mocks.recallExecute,
		}),
}));

import { writeAnswerDraft } from '../ai/composeDraftWrite';
import type { Id } from '../../_generated/dataModel';

type StreamOpts = Parameters<typeof DispatchModule.runLlmStream>[0];

const REPLY = 'Hi John,\n\nThanks for getting in touch. The room is yours.\n\nBest,\nAda';
const NARRATION = 'Let me check availability for those dates.';
const MARKUP =
	'<invoke name="recallKnowledge">\n' +
	'<parameter name="query">availability 14-16 December 2026 for 2 guests</parameter>\n' +
	'</invoke>\n\n' +
	'<function_results>\n{"results":[]}\n</function_results>';
const MARKUP_SHAPE = /<\/?(?:invoke|parameter|function_)/;

/** A mocked stream that delivers `text` in small chunks, as a model would. */
function streams(text: string) {
	return async (opts: StreamOpts) => {
		let full = '';
		for (let at = 0; at < text.length; at += 7) {
			full += text.slice(at, at + 7);
			await opts.onTextDelta?.(full, text.slice(at, at + 7));
		}
		return {
			text: full,
			tokenUsage: undefined,
			modelUsed: 'm',
			finishReason: 'stop',
			aborted: false,
		};
	};
}

function makeCtx() {
	const shown: string[] = [];
	const finals: Record<string, unknown>[] = [];
	const sessions: Record<string, unknown>[] = [];
	const ctx = {
		runMutation: vi.fn(async (ref: unknown, args: Record<string, unknown>) => {
			const name = getFunctionName(ref as Parameters<typeof getFunctionName>[0]);
			if (name.endsWith('openSessionStream')) return 'stream_1';
			if (name.endsWith('appendDraftStream')) {
				shown.push(args['text'] as string);
				return { stop: false };
			}
			if (name.endsWith('finalizeDraftStream')) finals.push(args);
			if (name.endsWith('updateSession')) sessions.push(args);
			return undefined;
		}),
		runQuery: vi.fn(),
		runAction: vi.fn(),
	};
	return {
		ctx: ctx as unknown as Parameters<typeof writeAnswerDraft>[0],
		shown,
		finals,
		sessions,
	};
}

function write(ctx: Parameters<typeof writeAnswerDraft>[0]) {
	return writeAnswerDraft(ctx, {
		sessionId: 'session_1' as Id<'answerAskSessions'>,
		context: 'Them: is a room free from 14 to 16 December for two?',
		audience: 'the mailbox owner',
		styleReference: "the owner's",
		toneInstruction: '',
		signatureInstruction: '',
		voiceSection: '',
		questions: [],
		attachedFiles: [],
	});
}

let clock = 0;
beforeEach(() => {
	// Every delta is past the flush interval, so every one is written out.
	vi.spyOn(Date, 'now').mockImplementation(() => (clock += 1_000));
	// Unless a test scripts the stream, the real one runs against mocks.model.
	mocks.runLlmStream.mockReset();
	mocks.runLlmStream.mockImplementation(mocks.actualRunLlmStream);
	mocks.recallExecute.mockClear();
	mocks.model = 'mock-model';
});
afterEach(() => {
	vi.restoreAllMocks();
});

describe('writeAnswerDraft — leaked tool-call markup', () => {
	it('never shows the markup prefix and finalizes the reply after it', async () => {
		mocks.runLlmStream.mockImplementationOnce(streams(MARKUP + REPLY));
		const { ctx, shown, finals, sessions } = makeCtx();
		await write(ctx);

		expect(shown.length).toBeGreaterThan(5);
		for (const text of shown) expect(REPLY.startsWith(text), JSON.stringify(text)).toBe(true);
		expect(finals).toEqual([expect.objectContaining({ text: REPLY, status: 'complete' })]);
		expect(sessions).toEqual([expect.objectContaining({ status: 'ready' })]);
		expect(mocks.runLlmStream).toHaveBeenCalledTimes(1);
		expect(mocks.runLlmStream.mock.calls[0]![0]).toMatchObject({ finalStepOnly: true });
	});

	it('writes the draft once more without tools when markup sits inside the reply', async () => {
		mocks.runLlmStream
			.mockImplementationOnce(streams(`${NARRATION}\n\n${MARKUP}${REPLY}`))
			.mockImplementationOnce(streams(REPLY));
		const { ctx, shown, finals, sessions } = makeCtx();
		await write(ctx);

		for (const text of shown) expect(text).not.toMatch(MARKUP_SHAPE);
		// The first attempt's text is cleared before the retry streams.
		expect(shown).toContain('');
		expect(shown[shown.length - 1]).toBe(REPLY);
		const retry = mocks.runLlmStream.mock.calls[1]![0] as StreamOpts;
		expect(retry.tools).toBeUndefined();
		expect(JSON.stringify(retry.messages)).not.toContain('recallKnowledge');
		expect(finals).toEqual([expect.objectContaining({ text: REPLY, status: 'complete' })]);
		expect(sessions).toEqual([expect.objectContaining({ status: 'ready' })]);
	});

	it('fails the draft and stores no markup when the retry is markup as well', async () => {
		mocks.runLlmStream
			.mockImplementationOnce(streams(`Hi John,\n\n${MARKUP}\nBest`))
			.mockImplementationOnce(streams(`${MARKUP}\n\n<tool_call>{"name":"recallKnowledge"}`));
		const { ctx, shown, finals, sessions } = makeCtx();
		await write(ctx);

		for (const text of shown) expect(text).not.toMatch(MARKUP_SHAPE);
		expect(finals).toEqual([
			expect.objectContaining({ text: '', status: 'error', errorMessage: 'draft_failed' }),
		]);
		expect(sessions).toEqual([expect.objectContaining({ status: 'error' })]);
	});

	it('drops narration written before a real tool call from the editor and the draft', async () => {
		mocks.model = scriptedStreamModel([
			{
				text: ['Let me check ', 'availability for those dates.'],
				toolCall: { toolName: 'recallKnowledge', input: { query: 'availability' } },
			},
			{
				text: ['Hi John,\n\n', 'Thanks for getting in touch. ', 'The room is yours.\n\nBest,\nAda'],
			},
		]);
		const { ctx, shown, finals } = makeCtx();
		await write(ctx);

		expect(mocks.recallExecute).toHaveBeenCalledTimes(1);
		const cleared = shown.indexOf('');
		expect(cleared).toBeGreaterThan(0);
		for (const text of shown.slice(cleared)) expect(REPLY.startsWith(text)).toBe(true);
		expect(shown[shown.length - 1]).toBe(REPLY);
		expect(finals).toEqual([expect.objectContaining({ text: REPLY, status: 'complete' })]);
	});
});
