import { MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { runLlmTextWithAttemptMetadata } from '../dispatch';
import { providerGenerationResult } from './providerModel.testlib';

const REQUESTED_MODEL_ID = 'requested-model';

function providerModel(response: unknown): MockLanguageModelV3 {
	return new MockLanguageModelV3({
		modelId: REQUESTED_MODEL_ID,
		doGenerate: async () => providerGenerationResult(response),
	});
}

describe('provider-reported model identity', () => {
	it('propagates a provider-reported model that differs from the request', async () => {
		const dispatched = await runLlmTextWithAttemptMetadata({
			model: providerModel({ modelId: 'provider-rerouted-model' }),
			prompt: 'hello',
		});

		expect(dispatched).toMatchObject({
			attempts: 1,
			result: {
				text: 'generated text',
				modelUsed: 'provider-rerouted-model',
				tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
			},
		});
	});

	it('does not use the AI SDK requested-model fallback when raw identity is absent', async () => {
		const dispatched = await runLlmTextWithAttemptMetadata({
			model: providerModel(undefined),
			prompt: 'hello',
		});

		expect(dispatched.result.modelUsed).toBeUndefined();
		expect(dispatched.result.modelUsed).not.toBe(REQUESTED_MODEL_ID);
	});

	it('uses raw identity from the successful retry attempt', async () => {
		let providerAttempts = 0;
		const model = new MockLanguageModelV3({
			modelId: REQUESTED_MODEL_ID,
			doGenerate: async () => {
				providerAttempts += 1;
				if (providerAttempts === 1) throw { statusCode: 429, message: 'retry' };
				return providerGenerationResult({ modelId: 'successful-retry-model' });
			},
		});

		const dispatched = await runLlmTextWithAttemptMetadata({ model, prompt: 'hello' });

		expect(dispatched.attempts).toBe(2);
		expect(dispatched.result.modelUsed).toBe('successful-retry-model');
	}, 10_000);

	it.each([
		['missing model id', {}],
		['non-string model id', { modelId: 42 }],
		['blank model id', { modelId: '   ' }],
		['model id with control characters', { modelId: 'model\nsecret' }],
		['oversized model id', { modelId: 'x'.repeat(257) }],
	])('rejects %s from raw provider metadata', async (_label, response) => {
		const dispatched = await runLlmTextWithAttemptMetadata({
			model: providerModel(response),
			prompt: 'hello',
		});

		expect(dispatched.result.modelUsed).toBeUndefined();
	});
});
