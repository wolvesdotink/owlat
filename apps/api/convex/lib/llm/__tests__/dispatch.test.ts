/**
 * Unit tests for `lib/llm/dispatch.ts` — see ADR-0029.
 *
 * Covers:
 *   - `normalizeUsage`: SDK-shape → TokenUsage validator mapping.
 *   - `runLlmText` discriminated input: `messages` variant,
 *     `{ prompt }` variant, `{ prompt, system }` variant.
 *   - `runLlmObject`: structured-output mapping + token-usage extraction.
 *
 * Pre-lift, the discriminator behaviour was only reachable via the agent
 * walker harness. Post-lift, this is a pure unit test against a mocked
 * AI SDK.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

const generateTextMock = vi.fn();
const generateObjectMock = vi.fn();

vi.mock('ai', async () => ({
	...(await vi.importActual('ai')),
	generateText: (args: unknown) => generateTextMock(args),
	generateObject: (args: unknown) => generateObjectMock(args),
}));

import {
	normalizeUsage,
	runLlmText,
	runLlmObject,
	runLlmTextWithAttemptMetadata,
	isRetriableLlmError,
} from '../dispatch';

const fakeModel = { modelId: 'fake-model-id' } as unknown as Parameters<
	typeof runLlmText
>[0]['model'];

beforeEach(() => {
	generateTextMock.mockReset();
	generateObjectMock.mockReset();
});

describe('normalizeUsage', () => {
	it('returns undefined when usage is undefined', () => {
		expect(normalizeUsage(undefined)).toBeUndefined();
	});

	it('maps a full SDK usage triple', () => {
		expect(normalizeUsage({ inputTokens: 100, outputTokens: 50, totalTokens: 150 })).toEqual({
			promptTokens: 100,
			completionTokens: 50,
			totalTokens: 150,
		});
	});

	it('zero-fills missing fields', () => {
		expect(normalizeUsage({ inputTokens: 12 })).toEqual({
			promptTokens: 12,
			completionTokens: 0,
			totalTokens: 0,
		});
		expect(normalizeUsage({ outputTokens: 7 })).toEqual({
			promptTokens: 0,
			completionTokens: 7,
			totalTokens: 0,
		});
		expect(normalizeUsage({})).toEqual({
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
		});
	});
});

describe('runLlmText input discriminator', () => {
	it('passes `messages` through to the SDK and returns normalized usage', async () => {
		generateTextMock.mockResolvedValueOnce({
			text: 'hello',
			usage: { inputTokens: 11, outputTokens: 22, totalTokens: 33 },
		});

		const result = await runLlmText({
			model: fakeModel,
			messages: [
				{ role: 'system', content: 'sys' },
				{ role: 'user', content: 'user' },
			],
			temperature: 0.3,
		});

		expect(generateTextMock).toHaveBeenCalledTimes(1);
		const sdkArgs = generateTextMock.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(sdkArgs['model']).toBe(fakeModel);
		expect(sdkArgs['temperature']).toBe(0.3);
		expect(sdkArgs['messages']).toEqual([
			{ role: 'system', content: 'sys' },
			{ role: 'user', content: 'user' },
		]);
		// Discriminated input — `prompt`/`system` must NOT leak when `messages` is given.
		expect(sdkArgs).not.toHaveProperty('prompt');
		expect(sdkArgs).not.toHaveProperty('system');

		expect(result).toEqual({
			text: 'hello',
			tokenUsage: { promptTokens: 11, completionTokens: 22, totalTokens: 33 },
			modelUsed: 'fake-model-id',
		});
	});

	it('passes `{ prompt }` through to the SDK', async () => {
		generateTextMock.mockResolvedValueOnce({
			text: 'visualized',
			usage: { inputTokens: 5, outputTokens: 10, totalTokens: 15 },
		});

		const result = await runLlmText({
			model: fakeModel,
			prompt: 'draw a pie chart',
		});

		const sdkArgs = generateTextMock.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(sdkArgs['prompt']).toBe('draw a pie chart');
		expect(sdkArgs['system']).toBeUndefined();
		expect(sdkArgs).not.toHaveProperty('messages');
		expect(result.text).toBe('visualized');
		expect(result.tokenUsage).toEqual({
			promptTokens: 5,
			completionTokens: 10,
			totalTokens: 15,
		});
		expect(result.modelUsed).toBe('fake-model-id');
	});

	it('passes `{ prompt, system }` through to the SDK', async () => {
		generateTextMock.mockResolvedValueOnce({
			text: 'ok',
			usage: undefined,
		});

		const result = await runLlmText({
			model: fakeModel,
			prompt: 'draw a pie chart',
			system: 'you are a chart bot',
		});

		const sdkArgs = generateTextMock.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(sdkArgs['prompt']).toBe('draw a pie chart');
		expect(sdkArgs['system']).toBe('you are a chart bot');
		expect(sdkArgs).not.toHaveProperty('messages');
		expect(result.text).toBe('ok');
		expect(result.tokenUsage).toBeUndefined();
		expect(result.modelUsed).toBe('fake-model-id');
	});

	it('retains a requested string model reference for core attribution', async () => {
		generateTextMock.mockResolvedValueOnce({
			text: '',
			usage: undefined,
		});

		const result = await runLlmText({
			model: 'string-model-id' as unknown as Parameters<typeof runLlmText>[0]['model'],
			prompt: 'hi',
		});

		expect(result.modelUsed).toBe('string-model-id');
	});
});

describe('runLlmObject', () => {
	it('returns the parsed object plus normalized usage + model', async () => {
		const schema = z.object({ greeting: z.string() });
		generateObjectMock.mockResolvedValueOnce({
			object: { greeting: 'hi' },
			usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
		});

		const result = await runLlmObject({
			model: fakeModel,
			schema,
			prompt: 'say hi',
			temperature: 0.1,
		});

		const sdkArgs = generateObjectMock.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(sdkArgs['model']).toBe(fakeModel);
		expect(sdkArgs['schema']).toBe(schema);
		expect(sdkArgs['prompt']).toBe('say hi');
		expect(sdkArgs['temperature']).toBe(0.1);

		expect(result).toEqual({
			object: { greeting: 'hi' },
			tokenUsage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
			modelUsed: 'fake-model-id',
		});
	});

	it('returns undefined tokenUsage when SDK omits usage', async () => {
		generateObjectMock.mockResolvedValueOnce({
			object: { a: 1 },
			usage: undefined,
		});

		const result = await runLlmObject({
			model: fakeModel,
			schema: z.object({ a: z.number() }),
			prompt: 'gimme',
		});

		expect(result.tokenUsage).toBeUndefined();
		expect(result.object).toEqual({ a: 1 });
	});
});

describe('isRetriableLlmError', () => {
	it('retries transient failures (429 / 5xx / timeouts / overload / unknown)', () => {
		expect(isRetriableLlmError({ statusCode: 429 })).toBe(true);
		expect(isRetriableLlmError({ statusCode: 503 })).toBe(true);
		expect(isRetriableLlmError({ status: 500 })).toBe(true);
		expect(isRetriableLlmError({ response: { status: 502 } })).toBe(true);
		expect(isRetriableLlmError(new Error('model is overloaded'))).toBe(true);
		expect(isRetriableLlmError(new Error('network timeout'))).toBe(true);
	});

	it('does NOT retry hard client errors (auth / bad request)', () => {
		expect(isRetriableLlmError({ statusCode: 401 })).toBe(false);
		expect(isRetriableLlmError({ statusCode: 403 })).toBe(false);
		expect(isRetriableLlmError({ statusCode: 400 })).toBe(false);
		expect(isRetriableLlmError(new Error('Invalid API key provided'))).toBe(false);
		expect(isRetriableLlmError(new Error('401 Unauthorized'))).toBe(false);
	});
});

describe('runLlmText retry behavior', () => {
	it('retries a transient failure then succeeds', async () => {
		generateTextMock
			.mockRejectedValueOnce({ statusCode: 429, message: 'rate limited' })
			.mockResolvedValueOnce({
				text: 'ok',
				usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
			});

		const result = await runLlmText({ model: fakeModel, prompt: 'hi' });
		expect(result.text).toBe('ok');
		expect(generateTextMock).toHaveBeenCalledTimes(2);
	}, 10_000);

	it('reports attempts and forwards a host-owned output ceiling through the metadata seam', async () => {
		generateTextMock
			.mockRejectedValueOnce({ statusCode: 429, message: 'rate limited' })
			.mockResolvedValueOnce({
				text: 'ok',
				usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
			});
		const result = await runLlmTextWithAttemptMetadata({
			model: fakeModel,
			prompt: 'hi',
			maxOutputTokens: 2048,
		});
		expect(result.attempts).toBe(2);
		expect(result.providerModelUsed).toBeUndefined();
		expect(generateTextMock.mock.calls[1]?.[0]).toMatchObject({ maxOutputTokens: 2048 });
	}, 10_000);

	it('bails immediately on a non-retriable auth error (no wasted retries)', async () => {
		generateTextMock.mockRejectedValue({ statusCode: 401, message: 'invalid api key' });
		await expect(runLlmText({ model: fakeModel, prompt: 'hi' })).rejects.toMatchObject({
			statusCode: 401,
		});
		expect(generateTextMock).toHaveBeenCalledTimes(1);
	});
});
