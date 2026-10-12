/**
 * Pins the documented Azure limit (see `lib/llmProviders/azure.ts`): Owlat has
 * no canonical model identity for an Azure deployment, so GPT-6 request handling
 * and list-price reporting apply only to deployments named after their model.
 * Transport is mocked; nothing reaches Azure.
 */
import { describe, expect, it } from 'vitest';
import { createAzure } from '@ai-sdk/azure';
import { modelForRequest } from '../requestPolicy';
import { estimateCost, estimateKnownCostMicrousd } from '../pricing';
import { classifyStoredLanguageEndpoint } from '../../llmProviders/types';

const prompt = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Hello' }] }];
const oneMillionEach = {
	promptTokens: 1_000_000,
	completionTokens: 1_000_000,
	totalTokens: 2_000_000,
};

async function capturedRequest(deployment: string): Promise<Record<string, unknown>> {
	let request: Record<string, unknown> | undefined;
	const azure = createAzure({
		apiKey: 'test',
		baseURL: 'https://acme.openai.azure.com/openai',
		fetch: async (_url, init) => {
			request = JSON.parse(init!.body as string);
			throw new Error('request captured');
		},
	});
	const model = modelForRequest(azure(deployment));
	if (typeof model !== 'object' || model.specificationVersion !== 'v3') {
		throw new Error('v3 expected');
	}
	await expect(model.doGenerate({ prompt, temperature: 0.2 })).rejects.toThrow('request captured');
	if (!request) throw new Error('no request');
	return request;
}

describe('Azure deployment identity', () => {
	it('applies GPT-6 handling to a deployment named after its model', async () => {
		for (const deployment of ['gpt-6-luna', 'gpt-6-luna-eu']) {
			const request = await capturedRequest(deployment);
			expect(request['reasoning']).toEqual({ effort: 'low' });
			expect(request).not.toHaveProperty('temperature');
		}
	});

	it('sends a custom-named deployment unchanged, even when it serves GPT-6', async () => {
		const model = createAzure({ apiKey: 'test', baseURL: 'https://acme.openai.azure.com/openai' })(
			'mail-fast'
		);
		expect(modelForRequest(model)).toBe(model);
		const request = await capturedRequest('mail-fast');
		expect(request['temperature']).toBe(0.2);
		expect(request).not.toHaveProperty('reasoning');
	});

	it('reports a custom-named deployment at the unknown-model default', () => {
		expect(estimateCost('mail-fast', oneMillionEach)).toEqual({ costUsd: 3 + 12, estimated: true });
		expect(estimateCost('gpt-6-luna-eu', oneMillionEach)).toEqual(
			estimateCost('gpt-6-luna', oneMillionEach)
		);
	});

	it('never admits an Azure endpoint to a hard budget, whatever the deployment is named', () => {
		for (const hasBaseUrl of [true, false]) {
			const provenance = classifyStoredLanguageEndpoint('azure', hasBaseUrl);
			expect(provenance).toBe('custom');
			expect(estimateKnownCostMicrousd(provenance, 'gpt-6-luna', oneMillionEach)).toBeUndefined();
		}
	});
});
