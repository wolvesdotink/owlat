/**
 * Per-request metering and the task limits in every dispatch mode (ADR-0073,
 * Phase 1a): each provider request, retries, tool rounds and stream steps
 * included, is one record on the call's meter with its own usage, and the
 * meter's task sets the output ceiling, the attempt allowance and the deadline.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { APICallError, NoObjectGeneratedError, tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
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
import { callDeadlineMs, taskOutputCeiling, wireOutputCeiling } from '../taskLimits';
import { DEFAULT_MODEL_MAX_OUTPUT_TOKENS, modelMaxOutputTokens } from '../modelOutputLimits';
import { stampModelEndpoint } from '../modelEndpoint';
import { LlmPartialUsageError } from '../partialUsage';
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

	it('sends no ceiling without a task or a caller ceiling, and the clamped one with a task', async () => {
		sdk.generateText.mockResolvedValue({ text: 'ok', usage: sdkUsage(1, 1) });
		await runLlmText({ model, prompt: 'hi' });
		await runLlmText({ model, prompt: 'hi', meter: new LlmCallMeter({ task: 'mail.translate' }) });
		expect(sdk.generateText.mock.calls[0]![0]).not.toHaveProperty('maxOutputTokens');
		// gpt-4o-mini accepts 16 384; translate asks for 24 576.
		expect(sdk.generateText.mock.calls[1]![0]).toMatchObject({ maxOutputTokens: 16_384 });
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

describe('runLlmStream — every provider request, at the provider boundary', () => {
	const recall = () =>
		tool({
			description: 'r',
			inputSchema: z.object({ q: z.string() }),
			execute: async () => ({ facts: [] as string[] }),
		});
	/** `inner`, except its first `failures` stream requests are refused with a 503. */
	function flaky(inner: MockLanguageModelV3, failures: number) {
		let refused = 0;
		return new MockLanguageModelV3({
			modelId: 'gpt-4o-mini',
			doStream: async (options) => {
				if (refused < failures) {
					refused += 1;
					throw new APICallError({
						message: 'overloaded',
						url: 'https://provider.test',
						requestBodyValues: {},
						statusCode: 503,
						isRetryable: true,
					});
				}
				return inner.doStream(options);
			},
		});
	}

	it('records a re-sent opening request: a 503, then the stream that answered', async () => {
		const meter = new LlmCallMeter({ task: 'assistant.answer' });
		await runLlmStream({
			model: flaky(scriptedStreamModel([{ text: ['Done.'] }]), 1),
			messages: [{ role: 'user', content: 'hi' }],
			meter,
		});
		expect(meter.requests.map((r) => [r.attempt, r.outcome, r.usage?.totalTokens])).toEqual([
			[1, 'failed', undefined],
			[2, 'ok', 15],
		]);
	}, 20_000);

	it('stops re-sending at the task’s attempt allowance', async () => {
		const meter = new LlmCallMeter({ task: 'mail.ask' }); // 2 attempts
		await expect(
			runLlmStream({
				model: flaky(scriptedStreamModel([{ text: ['Done.'] }]), 5),
				messages: [{ role: 'user', content: 'hi' }],
				meter,
			})
		).rejects.toThrow();
		expect(meter.requests.map((r) => r.outcome)).toEqual(['failed', 'failed']);
	}, 20_000);

	it('keeps the billed usage when the reader’s callback throws mid-stream', async () => {
		const meter = new LlmCallMeter({ task: 'assistant.answer' });
		const failure = new Error('could not persist the tool card');
		const error = await runLlmStream({
			model: scriptedStreamModel([
				{ text: ['Let me check.'], toolCall: { toolName: 'recall', input: { q: 'x' } } },
				{ text: ['Done.'] },
			]),
			messages: [{ role: 'user', content: 'hi' }],
			tools: { recall: recall() },
			onToolResult: () => {
				throw failure;
			},
			meter,
		}).catch((caught: unknown) => caught);

		// The first request finished and reported 15 tokens before the callback threw.
		expect(meter.requests[0]).toMatchObject({ attempt: 1, outcome: 'ok' });
		expect(meter.requests[0]!.usage?.totalTokens).toBe(15);
		expect(meter.requests.every((r) => r.attempt <= 2)).toBe(true);
		// The caller's error carries that usage too.
		expect(error).toBeInstanceOf(LlmPartialUsageError);
		expect((error as LlmPartialUsageError).tokenUsage.totalTokens).toBe(15);
		expect((error as LlmPartialUsageError).cause).toBe(failure);
	});

	it('sends the clamped ceiling and the task deadline on the stream request', async () => {
		const model = scriptedStreamModel([{ text: ['Done.'] }]);
		await runLlmStream({
			model,
			messages: [{ role: 'user', content: 'hi' }],
			meter: new LlmCallMeter({ task: 'assistant.answer' }),
		});
		// scripted-model is unknown: the default every chat model takes.
		expect(model.doStreamCalls[0]).toMatchObject({ maxOutputTokens: 4_096 });
		expect(model.doStreamCalls[0]!.abortSignal).toBeDefined();
	});
});

describe('runEmbedding', () => {
	it('marks a self-hosted embedder’s request as local, so it costs nothing', async () => {
		const local = stampModelEndpoint(
			{ modelId: 'nomic-embed-text', specificationVersion: 'v2' } as never,
			'embedding:local',
			{ isLocal: true }
		);
		sdk.embed.mockResolvedValueOnce({ embedding: [0.1], usage: { tokens: 100 } });
		const meter = new LlmCallMeter({ task: 'embedding.index' });
		await runEmbedding({ model: local, value: 'v', meter });
		expect(meter.requests[0]).toMatchObject({
			isLocalEngine: true,
			endpoint: 'embedding:local',
			usage: { promptTokens: 100, completionTokens: 0, totalTokens: 100 },
		});
	});

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
	it('gives every generative task a finite ceiling (output plus reasoning), embeddings none', () => {
		expect(taskOutputCeiling('plugin.invoke')).toBe(2048);
		expect(taskOutputCeiling('mail.classify')).toBe(1_024 + 4_096);
		expect(taskOutputCeiling('mail.draft')).toBe(8_192 + 8_192);
		expect(taskOutputCeiling('embedding.index')).toBeUndefined();
		expect(taskOutputCeiling(undefined)).toBeUndefined();
	});

	it('clamps the ceiling to the model’s maximum, with a safe default for an unknown model', () => {
		expect(wireOutputCeiling({ task: 'mail.translate', modelId: 'gpt-4o' })).toBe(16_384);
		expect(wireOutputCeiling({ task: 'mail.translate', modelId: 'openai/gpt-4o-mini' })).toBe(
			16_384
		);
		expect(wireOutputCeiling({ task: 'mail.draft', modelId: 'claude-3-haiku-20240307' })).toBe(
			4_096
		);
		expect(wireOutputCeiling({ task: 'mail.draft', modelId: 'gpt-6.1-sol' })).toBe(16_384);
		// An Azure deployment name, a local model: the default every chat model takes.
		expect(wireOutputCeiling({ task: 'mail.draft', modelId: 'mail-fast' })).toBe(
			DEFAULT_MODEL_MAX_OUTPUT_TOKENS
		);
		expect(wireOutputCeiling({ maxOutputTokens: 100_000, modelId: 'qwen3.6:27b' })).toBe(
			DEFAULT_MODEL_MAX_OUTPUT_TOKENS
		);
		expect(wireOutputCeiling({ modelId: 'gpt-4o' })).toBeUndefined();
		expect(modelMaxOutputTokens('anthropic/claude-sonnet-5.5')).toBe(32_000);
	});

	it('takes the tighter of the task deadline and the call’s absolute deadline', () => {
		const now = 1_000_000;
		expect(callDeadlineMs('mail.classify', undefined, now)).toBe(300_000);
		expect(callDeadlineMs('mail.classify', now + 5_000, now)).toBe(5_000);
		expect(callDeadlineMs('mail.category', undefined, now)).toBeUndefined();
		expect(callDeadlineMs(undefined, now - 1, now)).toBe(0);
	});
});
