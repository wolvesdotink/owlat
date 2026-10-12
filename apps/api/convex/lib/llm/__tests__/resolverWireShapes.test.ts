/**
 * Resolver → dispatch wire shapes for the env-configured OpenAI-compatible
 * routes (`LLM_PROVIDER=ollama | custom`). Real SDK clients, mocked transport:
 * nothing leaves the process.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { ActionCtx } from '../../../_generated/server';
import { __resetAiConfigCacheForTests, resolveLanguageModel } from '../../llmProvider';
import { runLlmObject } from '../dispatch';
import { modelForRequest } from '../requestPolicy';

const schema = z.object({ category: z.enum(['billing', 'support']), reason: z.string() });

/** No stored row: the resolver takes the env fallback. */
const envCtx = { runQuery: vi.fn(async () => null) } as unknown as ActionCtx;

let requests: { url: string; body: Record<string, unknown> }[];

function stubChatCompletions() {
	vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
		requests.push({ url: String(url), body: JSON.parse(init.body as string) });
		return new Response(
			JSON.stringify({
				id: 'chatcmpl-1',
				object: 'chat.completion',
				created: 0,
				model: 'm',
				choices: [
					{
						index: 0,
						message: { role: 'assistant', content: '{"category":"billing","reason":"r"}' },
						finish_reason: 'stop',
					},
				],
				usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
			}),
			{ status: 200, headers: { 'Content-Type': 'application/json' } }
		);
	});
}

beforeEach(() => {
	requests = [];
	__resetAiConfigCacheForTests();
	stubChatCompletions();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe('env OpenAI-compatible routes', () => {
	it.each([
		['ollama', undefined, 'http://ollama:11434/v1/chat/completions'],
		['custom', 'https://llm.example.com/v1', 'https://llm.example.com/v1/chat/completions'],
	] as const)(
		'%s sends structured calls with the caller schema as json_schema',
		async (provider, baseUrl, url) => {
			vi.stubEnv('LLM_PROVIDER', provider);
			if (baseUrl) {
				vi.stubEnv('LLM_BASE_URL', baseUrl);
				vi.stubEnv('LLM_API_KEY', 'env-key');
			}
			const model = await resolveLanguageModel(envCtx, 'mail.classify');
			const result = await runLlmObject({ model, schema, prompt: 'Classify', maxAttempts: 1 });

			expect(result.object).toEqual({ category: 'billing', reason: 'r' });
			expect(requests).toHaveLength(1);
			expect(requests[0]!.url).toBe(url);
			const format = requests[0]!.body['response_format'] as {
				type: string;
				json_schema: { schema: { properties: Record<string, unknown> } };
			};
			expect(format.type).toBe('json_schema');
			expect(Object.keys(format.json_schema.schema.properties)).toEqual(['category', 'reason']);
		}
	);

	it('applies the Luna chat rule to a custom OpenRouter endpoint', async () => {
		vi.stubEnv('LLM_PROVIDER', 'custom');
		vi.stubEnv('LLM_BASE_URL', 'https://openrouter.ai/api/v1');
		vi.stubEnv('LLM_API_KEY', 'env-key');
		vi.stubEnv('LLM_MODEL_FAST', 'openai/gpt-6-luna');
		const model = modelForRequest(await resolveLanguageModel(envCtx, 'mail.classify'));
		if (typeof model !== 'object' || model.specificationVersion !== 'v3') {
			throw new Error('v3 expected');
		}
		expect(model.provider).toBe('openai-compatible.chat');
		await model.doGenerate({
			prompt: [{ role: 'user', content: [{ type: 'text', text: 'Look it up' }] }],
			temperature: 0.2,
			tools: [
				{ type: 'function', name: 'lookup', inputSchema: { type: 'object', properties: {} } },
			],
		});

		const body = requests[0]!.body;
		expect(body['reasoning_effort']).toBe('none');
		expect(body).toHaveProperty('tools');
		expect(body).not.toHaveProperty('temperature');
	});
});

describe('schema fallback for a chat model without structured outputs', () => {
	it('puts the caller schema into the system prompt of a json_object request', async () => {
		const client = createOpenAICompatible({ name: 'bare', baseURL: 'https://llm.example.com/v1' });
		await runLlmObject({ model: client('m'), schema, prompt: 'Classify', maxAttempts: 1 });

		const body = requests[0]!.body;
		expect(body['response_format']).toEqual({ type: 'json_object' });
		const messages = body['messages'] as { role: string; content: string }[];
		expect(messages[0]!.role).toBe('system');
		expect(messages[0]!.content).toContain('JSON schema:');
		expect(messages[0]!.content).toContain('"category"');
		expect(messages[0]!.content).toContain('"billing"');
		expect(messages[messages.length - 1]).toMatchObject({ role: 'user', content: 'Classify' });
	});
});
