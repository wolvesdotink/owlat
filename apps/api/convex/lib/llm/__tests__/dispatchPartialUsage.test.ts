/**
 * The spend of a multi-step dispatch that fails partway (#1256). The tool loop
 * (`runLlmTextWithTools`) and the stream (`runLlmStream`) run against the real
 * AI SDK step loop with a scripted model: step 1 calls a tool and finishes
 * with usage, step 2 fails. The thrown error must carry step 1's usage, keep
 * the provider's error as its cause and keep its message.
 */

import { describe, it, expect, vi } from 'vitest';
import { tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';
import { runLlmStream, runLlmTextWithTools } from '../dispatch';
import { LlmPartialUsageError, partialUsageOf } from '../partialUsage';
import { providerGenerationResult } from './providerModel.testlib';
import { scriptedStreamModel } from './streamModel.testlib';

type GenerationResult = Awaited<ReturnType<MockLanguageModelV3['doGenerate']>>;

/** What every finished scripted step reports (providerModel.testlib's usage). */
const STEP_USAGE = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };

function recallTools() {
	return {
		recallKnowledge: tool({
			description: 'Fetch a fact',
			inputSchema: z.object({ query: z.string() }),
			execute: vi.fn(async () => ({ facts: [] as string[] })),
		}),
	};
}

/** A finished step that calls the recall tool, so the loop asks for another step. */
function toolCallStep(): GenerationResult {
	return {
		...providerGenerationResult(undefined),
		content: [
			{
				type: 'tool-call',
				toolCallId: 'call-1',
				toolName: 'recallKnowledge',
				input: JSON.stringify({ query: 'availability' }),
			},
		],
		finishReason: { unified: 'tool-calls', raw: undefined },
	};
}

/** A provider rejection the retry policy does not retry (a 400). */
function badRequest(): Error {
	return Object.assign(new Error('Bad request: context window exceeded'), { statusCode: 400 });
}

/** A generate model that plays `steps` in order; an Error entry is thrown. */
function generateModel(steps: ReadonlyArray<GenerationResult | Error>): MockLanguageModelV3 {
	let calls = 0;
	return new MockLanguageModelV3({
		modelId: 'tool-model',
		doGenerate: async () => {
			const step = steps[calls];
			calls += 1;
			if (step === undefined) throw new Error(`no step ${calls}`);
			if (step instanceof Error) throw step;
			return step;
		},
	});
}

const messages = [{ role: 'user' as const, content: 'Draft a reply.' }];

describe('runLlmTextWithTools — usage of finished steps', () => {
	it('throws the usage of a finished tool step when the next step fails', async () => {
		const original = badRequest();
		const error = await runLlmTextWithTools({
			model: generateModel([toolCallStep(), original]),
			messages,
			tools: recallTools(),
		}).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(LlmPartialUsageError);
		expect(partialUsageOf(error)).toEqual({ tokenUsage: STEP_USAGE, modelUsed: 'tool-model' });
		expect((error as Error).cause).toBe(original);
		expect((error as Error).message).toBe(original.message);
	});

	it('rethrows the provider error untouched when no step finished', async () => {
		const original = badRequest();
		const error = await runLlmTextWithTools({
			model: generateModel([original]),
			messages,
			tools: recallTools(),
		}).catch((e: unknown) => e);

		expect(error).toBe(original);
		expect(partialUsageOf(error)).toBeUndefined();
	});

	it('returns the usage of every step, not only the last one', async () => {
		const result = await runLlmTextWithTools({
			model: generateModel([toolCallStep(), providerGenerationResult(undefined, 'Hi John')]),
			messages,
			tools: recallTools(),
		});

		expect(result.text).toBe('Hi John');
		expect(result.tokenUsage).toEqual({ promptTokens: 20, completionTokens: 10, totalTokens: 30 });
	});

	it('counts the finished steps of an attempt that failed and was retried', async () => {
		const overloaded = Object.assign(new Error('overloaded'), { statusCode: 503 });
		const result = await runLlmTextWithTools({
			model: generateModel([toolCallStep(), overloaded, providerGenerationResult(undefined, 'Hi')]),
			messages,
			tools: recallTools(),
		});

		// Attempt 1 paid for its tool step before it failed; attempt 2 is one step.
		expect(result.text).toBe('Hi');
		expect(result.tokenUsage).toEqual({ promptTokens: 20, completionTokens: 10, totalTokens: 30 });
	}, 10_000);
});

describe('runLlmStream — usage of finished steps', () => {
	it('throws the usage of a finished tool step when the next step fails', async () => {
		// The scripted model has no second step, so its second stream call throws.
		const error = await runLlmStream({
			model: scriptedStreamModel([
				{ text: ['Let me check.'], toolCall: { toolName: 'recallKnowledge', input: { q: 'x' } } },
			]),
			messages,
			tools: recallTools(),
		}).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(LlmPartialUsageError);
		expect(partialUsageOf(error)).toEqual({ tokenUsage: STEP_USAGE, modelUsed: 'scripted-model' });
		expect(((error as Error).cause as Error).message).toBe('scripted model has no step 2');
		expect((error as Error).message).toBe('scripted model has no step 2');
	});

	it('rethrows the provider error untouched when no step finished', async () => {
		const error = await runLlmStream({
			model: scriptedStreamModel([]),
			messages,
		}).catch((e: unknown) => e);

		expect(error).not.toBeInstanceOf(LlmPartialUsageError);
		expect((error as Error).message).toBe('scripted model has no step 1');
	});

	it('returns the usage of the finished steps when the stream is aborted', async () => {
		const controller = new AbortController();
		const result = await runLlmStream({
			model: scriptedStreamModel([
				{ text: ['Let me check.'], toolCall: { toolName: 'recallKnowledge', input: { q: 'x' } } },
				{ text: ['Hi ', 'John', ', the room is yours.'] },
			]),
			messages,
			tools: recallTools(),
			abortSignal: controller.signal,
			onTextDelta: (full) => {
				if (full.endsWith('Hi ')) controller.abort();
			},
		});

		expect(result.aborted).toBe(true);
		expect(result.tokenUsage).toEqual(STEP_USAGE);
	});
});
