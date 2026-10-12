/**
 * Per-request metering and the task limits in every dispatch mode (ADR-0073,
 * Phase 1a): each provider request, retries, tool rounds and stream steps
 * included, is one record on the call's meter with its own usage, and the
 * meter's task sets the output ceiling, the attempt allowance and the deadline.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NoObjectGeneratedError, tool } from 'ai';
import { z } from 'zod';

const sdk = vi.hoisted(() => ({
	generateText: vi.fn(),
	generateObject: vi.fn(),
	embed: vi.fn(),
}));

vi.mock('ai', async () => ({
	...(await vi.importActual<object>('ai')),
	generateText: (args: unknown) => sdk.generateText(args),
	generateObject: (args: unknown) => sdk.generateObject(args),
	embed: (args: unknown) => sdk.embed(args),
}));

import { runLlmObject, runLlmStream, runLlmText, runLlmTextWithTools } from '../dispatch';
import { runEmbedding } from '../embed';
import { LlmCallMeter } from '../requestMeter';
import { callDeadlineMs, taskOutputCeiling } from '../taskLimits';
import { stampModelEndpoint } from '../modelEndpoint';
import { scriptedStreamModel } from './streamModel.testlib';

const model = stampModelEndpoint(
	{ modelId: 'gpt-4o-mini', specificationVersion: 'v2' } as never,
	'openai-native'
);
const sdkUsage = (input: number, output: number) => ({
	inputTokens: input,
	outputTokens: output,
	totalTokens: input + output,
	inputTokenDetails: { cacheReadTokens: 3, cacheWriteTokens: undefined },
	outputTokenDetails: { reasoningTokens: 2 },
});
const overloaded = () => Object.assign(new Error('overloaded'), { statusCode: 529 });

beforeEach(() => {
	sdk.generateText.mockReset();
	sdk.generateObject.mockReset();
	sdk.embed.mockReset();
});

describe('runLlmText', () => {
	it('records each attempt as one request: the failed retry, then the answer', async () => {
		sdk.generateText
			.mockRejectedValueOnce(overloaded())
			.mockResolvedValueOnce({ text: 'ok', usage: sdkUsage(10, 4) });
		const meter = new LlmCallMeter({ task: 'mail.ask' });

		await runLlmText({ model, prompt: 'hi', meter });

		expect(meter.requests).toEqual([
			expect.objectContaining({ attempt: 1, outcome: 'failed', modelUsed: 'gpt-4o-mini' }),
			expect.objectContaining({
				attempt: 2,
				outcome: 'ok',
				usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
				cacheReadTokens: 3,
				reasoningTokens: 2,
				endpoint: 'openai-native',
			}),
		]);
		expect(meter.requests[0]!.usage).toBeUndefined();
		for (const request of meter.requests) expect(request.latencyMs).toBeGreaterThanOrEqual(0);
	});

	it('enforces the task’s attempt allowance below the caller’s', async () => {
		sdk.generateText.mockRejectedValue(overloaded());
		const meter = new LlmCallMeter({ task: 'mail.ask' }); // 2 attempts: an interactive surface
		await expect(runLlmText({ model, prompt: 'hi', meter, maxAttempts: 3 })).rejects.toThrow(
			'overloaded'
		);
		expect(sdk.generateText).toHaveBeenCalledTimes(2);
		expect(meter.requests).toHaveLength(2);
	});

	it('sends the task’s output ceiling, and never raises a lower caller ceiling', async () => {
		sdk.generateText.mockResolvedValue({ text: 'ok', usage: sdkUsage(1, 1) });
		await runLlmText({ model, prompt: 'hi', meter: new LlmCallMeter({ task: 'plugin.invoke' }) });
		expect(sdk.generateText.mock.calls[0]![0]).toMatchObject({ maxOutputTokens: 2048 });
		await runLlmText({
			model,
			prompt: 'hi',
			maxOutputTokens: 100,
			meter: new LlmCallMeter({ task: 'plugin.invoke' }),
		});
		expect(sdk.generateText.mock.calls[1]![0]).toMatchObject({ maxOutputTokens: 100 });
	});

	it('keeps today’s request when the task sets no ceiling (no meter, no limit)', async () => {
		sdk.generateText.mockResolvedValue({ text: 'ok', usage: sdkUsage(1, 1) });
		await runLlmText({ model, prompt: 'hi', meter: new LlmCallMeter({ task: 'mail.ask' }) });
		await runLlmText({ model, prompt: 'hi' });
		for (const [args] of sdk.generateText.mock.calls) {
			expect(args).not.toHaveProperty('maxOutputTokens');
		}
	});

	it('cancels a call that outlives its root deadline, and records the request', async () => {
		sdk.generateText.mockImplementation(
			({ abortSignal }: { abortSignal: AbortSignal }) =>
				new Promise((_resolve, reject) =>
					abortSignal.addEventListener('abort', () => reject(abortSignal.reason), { once: true })
				)
		);
		const meter = new LlmCallMeter({
			task: 'mail.classify',
			root: { rootRequestId: 'team:m1', deadlineAt: Date.now() + 30 },
		});
		await expect(runLlmText({ model, prompt: 'hi', meter })).rejects.toThrow();
		expect(meter.requests).toEqual([expect.objectContaining({ attempt: 1, outcome: 'failed' })]);
	});
});

describe('runLlmObject', () => {
	it('records the billed usage of each schema failure on its own request (#1260)', async () => {
		const failure = () =>
			new NoObjectGeneratedError({
				message: 'did not match schema',
				text: '{}',
				response: { id: 'r', timestamp: new Date(), modelId: 'gpt-4o-mini' },
				usage: sdkUsage(7, 3),
				finishReason: 'stop',
			} as never);
		sdk.generateObject
			.mockRejectedValueOnce(failure())
			.mockRejectedValueOnce(failure())
			.mockResolvedValueOnce({ object: { ok: true }, usage: sdkUsage(7, 2) });
		const meter = new LlmCallMeter({ task: 'mail.classify' });

		const result = await runLlmObject({
			model,
			schema: z.object({ ok: z.boolean() }),
			prompt: 'p',
			meter,
		});

		expect(meter.requests.map((r) => [r.attempt, r.outcome, r.usage?.totalTokens])).toEqual([
			[1, 'failed', 10],
			[2, 'failed', 10],
			[3, 'ok', 9],
		]);
		// The call's summed usage still comes back for the caller's own reporting.
		expect(result.tokenUsage?.totalTokens).toBe(29);
	});

	it('sends an output ceiling on structured output too', async () => {
		sdk.generateObject.mockResolvedValue({ object: {}, usage: sdkUsage(1, 1) });
		await runLlmObject({
			model,
			schema: z.object({}),
			prompt: 'p',
			maxOutputTokens: 512,
			meter: new LlmCallMeter({ task: 'mail.classify' }),
		});
		expect(sdk.generateObject.mock.calls[0]![0]).toMatchObject({ maxOutputTokens: 512 });
	});
});

describe('runLlmTextWithTools', () => {
	it('records every tool round as its own request', async () => {
		sdk.generateText.mockImplementation(
			async ({ onStepFinish }: { onStepFinish: (step: unknown) => void }) => {
				onStepFinish({ usage: sdkUsage(10, 1) });
				onStepFinish({ usage: sdkUsage(12, 5) });
				return { text: 'done', totalUsage: sdkUsage(22, 6) };
			}
		);
		const meter = new LlmCallMeter({ task: 'mail.draft' });
		await runLlmTextWithTools({ model, messages: [], tools: {}, meter });
		expect(meter.requests.map((r) => [r.attempt, r.usage?.totalTokens])).toEqual([
			[1, 11],
			[2, 17],
		]);
	});

	it('records the round a failure interrupted, after the finished ones', async () => {
		sdk.generateText.mockImplementation(
			async ({ onStepFinish }: { onStepFinish: (step: unknown) => void }) => {
				onStepFinish({ usage: sdkUsage(10, 1) });
				throw Object.assign(new Error('bad request'), { statusCode: 400 });
			}
		);
		const meter = new LlmCallMeter({ task: 'mail.draft' });
		await expect(runLlmTextWithTools({ model, messages: [], tools: {}, meter })).rejects.toThrow(
			'bad request'
		);
		expect(meter.requests.map((r) => [r.outcome, r.usage?.totalTokens])).toEqual([
			['ok', 11],
			['failed', undefined],
		]);
	});
});

describe('runLlmStream', () => {
	it('records each stream step as one request with its usage', async () => {
		const meter = new LlmCallMeter({ task: 'assistant.answer' });
		const execute = vi.fn(async () => ({ facts: [] as string[] }));
		await runLlmStream({
			model: scriptedStreamModel([
				{ text: ['Let me check.'], toolCall: { toolName: 'recall', input: { q: 'x' } } },
				{ text: ['Done.'] },
			]),
			messages: [{ role: 'user', content: 'hi' }],
			tools: {
				recall: tool({ description: 'r', inputSchema: z.object({ q: z.string() }), execute }),
			},
			meter,
		});
		expect(meter.requests.map((r) => [r.attempt, r.outcome, r.usage?.totalTokens])).toEqual([
			[1, 'ok', 15],
			[2, 'ok', 15],
		]);
	});

	it('records the request a step limit never sent as nothing', async () => {
		const meter = new LlmCallMeter({ task: 'assistant.answer' });
		await runLlmStream({
			model: scriptedStreamModel([
				{ text: ['Let me check.'], toolCall: { toolName: 'recall', input: { q: 'x' } } },
			]),
			messages: [{ role: 'user', content: 'hi' }],
			maxSteps: 1,
			tools: {
				recall: tool({
					description: 'r',
					inputSchema: z.object({ q: z.string() }),
					execute: async () => ({}),
				}),
			},
			meter,
		});
		expect(meter.requests).toHaveLength(1);
	});
});

describe('runEmbedding', () => {
	it('records an embedding request with its input tokens, through the shared retry', async () => {
		const embeddingModel = stampModelEndpoint(
			{ modelId: 'text-embedding-3-small', specificationVersion: 'v2' } as never,
			'embedding:openai'
		);
		sdk.embed
			.mockRejectedValueOnce(overloaded())
			.mockResolvedValueOnce({ embedding: [0.1, 0.2], usage: { tokens: 42 } });
		const meter = new LlmCallMeter({ task: 'embedding.query' });

		const result = await runEmbedding({ model: embeddingModel, value: 'q', meter });

		expect(result.embedding).toEqual([0.1, 0.2]);
		expect(sdk.embed.mock.calls[0]![0]).toMatchObject({ maxRetries: 0 });
		expect(meter.requests).toEqual([
			expect.objectContaining({ attempt: 1, outcome: 'failed' }),
			expect.objectContaining({
				attempt: 2,
				outcome: 'ok',
				usage: { promptTokens: 42, completionTokens: 0, totalTokens: 42 },
				modelUsed: 'text-embedding-3-small',
				endpoint: 'embedding:openai',
			}),
		]);
	});
});

describe('task limits', () => {
	it('adds the reasoning ceiling to the output ceiling, and sends none without one', () => {
		expect(taskOutputCeiling('plugin.invoke')).toBe(2048);
		expect(taskOutputCeiling('mail.draft')).toBeUndefined();
		expect(taskOutputCeiling(undefined)).toBeUndefined();
	});

	it('takes the tighter of the task deadline and the root deadline', () => {
		const now = 1_000_000;
		expect(callDeadlineMs('mail.classify', undefined, now)).toBe(300_000);
		expect(callDeadlineMs('mail.classify', { rootRequestId: 'r', deadlineAt: now + 5_000 }, now)).toBe(
			5_000
		);
		expect(callDeadlineMs('mail.category', undefined, now)).toBeUndefined();
		expect(callDeadlineMs(undefined, { rootRequestId: 'r', deadlineAt: now - 1 }, now)).toBe(0);
	});
});
