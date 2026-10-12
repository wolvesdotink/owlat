import { describe, expect, it } from 'vitest';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { modelForRequest } from '../requestPolicy';

const prompt = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Hello' }] }];

describe('current model wire compatibility', () => {
	it.each(['doGenerate', 'doStream'] as const)(
		'uses low reasoning without sampling for GPT-6 %s',
		async (method) => {
			let request: Record<string, unknown> | undefined;
			const client = createOpenAI({
				apiKey: 'test',
				fetch: async (_url, init) => {
					request = JSON.parse(init!.body as string);
					throw new Error('request captured');
				},
			});
			const model = modelForRequest(client('gpt-6-luna'));
			if (typeof model !== 'object' || model.specificationVersion !== 'v3')
				throw new Error('v3 expected');
			await expect(model[method]({ prompt, temperature: 0.2, topP: 0.9 })).rejects.toThrow(
				'request captured'
			);
			expect(request?.['reasoning']).toEqual({ effort: 'low' });
			expect(request).not.toHaveProperty('temperature');
			expect(request).not.toHaveProperty('top_p');
		}
	);

	it('keeps a caller-chosen GPT-6 reasoning effort', async () => {
		let request: Record<string, unknown> | undefined;
		const client = createOpenAI({
			apiKey: 'test',
			fetch: async (_url, init) => {
				request = JSON.parse(init!.body as string);
				throw new Error('request captured');
			},
		});
		const model = modelForRequest(client('gpt-6.1-sol'));
		if (typeof model !== 'object' || model.specificationVersion !== 'v3')
			throw new Error('v3 expected');
		await expect(
			model.doGenerate({ prompt, providerOptions: { openai: { reasoningEffort: 'high' } } })
		).rejects.toThrow('request captured');
		expect(request?.['reasoning']).toEqual({ effort: 'high' });
	});

	it('omits sampling for native Claude 5.5', async () => {
		let request: Record<string, unknown> | undefined;
		const client = createAnthropic({
			apiKey: 'test',
			fetch: async (_url, init) => {
				request = JSON.parse(init!.body as string);
				throw new Error('request captured');
			},
		});
		const model = modelForRequest(client('claude-sonnet-5-5'));
		if (typeof model !== 'object' || model.specificationVersion !== 'v3')
			throw new Error('v3 expected');
		await expect(model.doGenerate({ prompt, temperature: 0.2 })).rejects.toThrow(
			'request captured'
		);
		expect(request).not.toHaveProperty('temperature');
	});

	it('preserves legacy models', () => {
		const model = createOpenAI({ apiKey: 'test' })('gpt-4o');
		expect(modelForRequest(model)).toBe(model);
	});

	it('disables reasoning for Luna tools through the OpenRouter compatible wire', async () => {
		let request: Record<string, unknown> | undefined;
		const client = createOpenAICompatible({
			name: 'openrouter',
			baseURL: 'https://openrouter.ai/api/v1',
			apiKey: 'test',
			fetch: async (_url, init) => {
				request = JSON.parse(init!.body as string);
				throw new Error('request captured');
			},
		});
		const model = modelForRequest(client('openai/gpt-6-luna'));
		if (typeof model !== 'object' || model.specificationVersion !== 'v3')
			throw new Error('v3 expected');
		await expect(
			model.doGenerate({
				prompt,
				temperature: 0.2,
				tools: [
					{
						type: 'function',
						name: 'lookup',
						inputSchema: { type: 'object', properties: {} },
					},
				],
			})
		).rejects.toThrow('request captured');
		expect(request?.['reasoning_effort']).toBe('none');
		expect(request).toHaveProperty('tools');
		expect(request).not.toHaveProperty('temperature');
	});
});
