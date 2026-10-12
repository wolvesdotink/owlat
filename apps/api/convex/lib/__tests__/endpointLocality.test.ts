/**
 * Endpoint locality (ADR-0073): one rule for every plane decides which model
 * requests are free. Unknown locality is priced, never free.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ActionCtx } from '../../_generated/server';
import type { Doc } from '../../_generated/dataModel';
import { isLocalHostname, resolveEndpointLocality } from '../llm/endpointLocality';

// Fresh model objects per build, so each stamp is checked on its own object.
vi.mock('@ai-sdk/openai-compatible', () => ({
	createOpenAICompatible: () =>
		Object.assign((modelId: string) => ({ modelId, provider: 'openai-compatible.chat' }), {
			textEmbeddingModel: (modelId: string) => ({
				modelId,
				provider: 'openai-compatible.embedding',
			}),
		}),
}));

function makeCtx(row: Partial<Doc<'aiProviderConfig'>>) {
	const stored = {
		_id: 'cfg1',
		_creationTime: 0,
		languageProviderKind: 'openaiCompatible',
		modelFast: 'qwen3.6:27b',
		modelCapable: 'qwen3.6:27b',
		embeddingProviderKind: 'local',
		embeddingModelVersion: 1,
		updatedAt: 1,
		...row,
	};
	return {
		runQuery: vi.fn(async () => stored),
		runAction: vi.fn(async () => 'decrypted-key'),
	} as unknown as ActionCtx;
}

describe('resolveEndpointLocality', () => {
	it.each([
		'http://localhost:11434/v1',
		'http://127.0.0.1:8000/v1',
		'http://[::1]:11434/v1',
		'http://10.0.0.5/v1',
		'http://172.20.1.2/v1',
		'http://192.168.1.10:11434/v1',
		'http://169.254.0.9/v1',
		'http://[fd12:3456::1]/v1',
		'http://ollama:11434/v1',
		'http://gpu-box.local/v1',
		'http://vllm.internal:8000/v1',
	])('reads an OpenAI-compatible endpoint at %s as local', (url) => {
		expect(resolveEndpointLocality('openaiCompatible', url)).toBe('local');
	});

	it.each([
		'https://openrouter.ai/api/v1',
		'https://api.together.xyz/v1',
		'http://8.8.8.8/v1',
		'http://172.32.0.1/v1',
		'not a url',
	])('reads an OpenAI-compatible endpoint at %s as hosted (priced)', (url) => {
		expect(resolveEndpointLocality('openaiCompatible', url)).toBe('hosted');
	});

	it('fails closed: no URL, or a hosted kind, is hosted; a local kind is local', () => {
		expect(resolveEndpointLocality('openaiCompatible', undefined)).toBe('hosted');
		expect(resolveEndpointLocality('openai', 'http://localhost:1234')).toBe('hosted');
		expect(resolveEndpointLocality('typesafe', undefined)).toBe('hosted');
		expect(resolveEndpointLocality('llm', undefined)).toBe('hosted');
		expect(resolveEndpointLocality('local', undefined)).toBe('local');
		expect(resolveEndpointLocality('local', 'https://example.com')).toBe('local');
		expect(isLocalHostname('')).toBe(false);
	});
});

describe('the resolver stamps locality on both planes', () => {
	beforeEach(() => {
		vi.resetModules();
		vi.unstubAllEnvs();
	});
	afterEach(() => vi.unstubAllEnvs());

	it.each([
		['http://localhost:11434/v1', true],
		['http://ollama:11434/v1', true],
		['https://openrouter.ai/api/v1', false],
	])('language: an OpenAI-compatible server at %s is local: %s', async (url, isLocal) => {
		const { resolveLanguageModel } = await import('../llmProvider');
		const { isLocalModel } = await import('../llm/modelEndpoint');
		const model = await resolveLanguageModel(makeCtx({ languageBaseUrl: url }), 'classify');
		expect(isLocalModel(model)).toBe(isLocal);
	});

	it.each([
		['http://ollama:11434/v1', true],
		['https://openrouter.ai/api/v1', false],
	])('embedding: an OpenAI-compatible embedder at %s is local: %s', async (url, isLocal) => {
		vi.stubEnv('LOCAL_EMBEDDING_BASE_URL', url);
		const { resolveIndexEmbedder } = await import('../llmProvider');
		const { isLocalModel } = await import('../llm/modelEndpoint');
		const { model } = await resolveIndexEmbedder(
			makeCtx({ embeddingProviderKind: 'openaiCompatible' })
		);
		expect(isLocalModel(model)).toBe(isLocal);
	});

	it('embedding: the bundled local sidecar is local', async () => {
		const { resolveIndexEmbedder } = await import('../llmProvider');
		const { isLocalModel } = await import('../llm/modelEndpoint');
		const { model } = await resolveIndexEmbedder(makeCtx({ embeddingProviderKind: 'local' }));
		expect(isLocalModel(model)).toBe(true);
	});
});
