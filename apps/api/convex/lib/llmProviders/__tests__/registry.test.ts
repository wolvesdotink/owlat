import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub both SDK boundaries: the factories return a callable client whose call
// (and `.embedding`) yield a tagged model so we can assert what was built
// without any real provider construction or network.
//
// The mock handles are created via `vi.hoisted` so they are initialized before
// vitest hoists the `vi.mock` factories (and the static `../index` import that
// triggers the mocked-module load) — otherwise the factories would close over
// not-yet-initialized consts and throw "Cannot access … before initialization".
const { mockOpenAIClient, mockCreateOpenAI, mockCompatibleClient, mockCreateOpenAICompatible } =
	vi.hoisted(() => {
		const openAIClient = Object.assign(
			vi.fn((id: string) => ({ modelId: id, provider: 'openai' })),
			{ embedding: vi.fn((id: string) => ({ modelId: id, provider: 'openai-embedding' })) }
		);
		const compatibleClient = vi.fn((id: string) => ({
			modelId: id,
			provider: 'openai-compatible',
		}));
		return {
			mockOpenAIClient: openAIClient,
			mockCreateOpenAI: vi.fn(() => openAIClient),
			mockCompatibleClient: compatibleClient,
			mockCreateOpenAICompatible: vi.fn(() => compatibleClient),
		};
	});

vi.mock('@ai-sdk/openai', () => ({ createOpenAI: mockCreateOpenAI }));
vi.mock('@ai-sdk/openai-compatible', () => ({
	createOpenAICompatible: mockCreateOpenAICompatible,
}));

import {
	EMBEDDING_PROVIDER_KINDS,
	LANGUAGE_PROVIDER_KINDS,
	LANGUAGE_PROVIDERS,
	EMBEDDING_PROVIDERS,
	embeddingProviderFor,
	languageProviderFor,
} from '../index';

describe('llmProviders registry', () => {
	beforeEach(() => {
		mockCreateOpenAI.mockClear();
		mockCreateOpenAICompatible.mockClear();
		mockOpenAIClient.mockClear();
		mockOpenAIClient.embedding.mockClear();
		mockCompatibleClient.mockClear();
	});

	it('registers an adapter for every language kind (completeness)', () => {
		for (const kind of LANGUAGE_PROVIDER_KINDS) {
			expect(LANGUAGE_PROVIDERS[kind].kind).toBe(kind);
		}
		expect(Object.keys(LANGUAGE_PROVIDERS).sort()).toEqual([...LANGUAGE_PROVIDER_KINDS].sort());
	});

	it('registers an adapter for every embedding kind (completeness)', () => {
		for (const kind of EMBEDDING_PROVIDER_KINDS) {
			expect(EMBEDDING_PROVIDERS[kind].kind).toBe(kind);
		}
		expect(Object.keys(EMBEDDING_PROVIDERS).sort()).toEqual([...EMBEDDING_PROVIDER_KINDS].sort());
	});

	it('exposes the openai language adapter as a hosted (non-local) provider', () => {
		const adapter = languageProviderFor('openai');
		expect(adapter.kind).toBe('openai');
		expect(adapter.isLocal).toBe(false);
		expect(adapter.defaultModels).toEqual({ fast: 'gpt-5.6-luna', capable: 'gpt-5.6-sol' });
	});

	it('exposes the openaiCompatible adapter as a local provider', () => {
		const adapter = languageProviderFor('openaiCompatible');
		expect(adapter.kind).toBe('openaiCompatible');
		expect(adapter.isLocal).toBe(true);
		expect(adapter.defaultBaseUrl).toBeDefined();
	});

	it('builds an openai chat model through its client', () => {
		const model = languageProviderFor('openai').buildChatModel({ apiKey: 'k' }, 'gpt-4o');
		expect(mockCreateOpenAI).toHaveBeenCalledWith(
			expect.objectContaining({ apiKey: 'k', baseURL: undefined })
		);
		expect(mockOpenAIClient).toHaveBeenCalledWith('gpt-4o');
		expect(model).toMatchObject({ modelId: 'gpt-4o' });
	});

	it('builds an openai embedding model sharing the language client cache', () => {
		languageProviderFor('openai').buildChatModel({ apiKey: 'shared' }, 'gpt-4o');
		embeddingProviderFor('openai').buildEmbeddingModel({
			apiKey: 'shared',
			modelId: 'text-embedding-3-small',
		});
		// One client for both planes at the same (baseUrl, key-fingerprint).
		expect(mockCreateOpenAI).toHaveBeenCalledTimes(1);
		expect(mockOpenAIClient.embedding).toHaveBeenCalledWith('text-embedding-3-small');
	});

	it('builds an openaiCompatible chat model when a base URL is present', () => {
		const model = languageProviderFor('openaiCompatible').buildChatModel(
			{ baseUrl: 'http://localhost:11434/v1' },
			'llama3.1'
		);
		expect(mockCreateOpenAICompatible).toHaveBeenCalledWith(
			expect.objectContaining({ baseURL: 'http://localhost:11434/v1' })
		);
		expect(model).toMatchObject({ modelId: 'llama3.1' });
	});

	it('rejects an openaiCompatible build with no base URL', () => {
		expect(() => languageProviderFor('openaiCompatible').buildChatModel({}, 'llama3.1')).toThrow(
			/base URL/
		);
		expect(() => languageProviderFor('openaiCompatible').validateCredentials({})).toThrow(
			/base URL/
		);
	});

	it('requires an API key for the openai adapter', () => {
		expect(() => languageProviderFor('openai').validateCredentials({})).toThrow(/API key/);
		expect(() => languageProviderFor('openai').validateCredentials({ apiKey: 'k' })).not.toThrow();
	});

	it('throws on an unknown provider kind', () => {
		// @ts-expect-error — exercising the runtime guard with an off-union kind.
		expect(() => languageProviderFor('nope')).toThrow(/Unknown language provider/);
		// @ts-expect-error — exercising the runtime guard with an off-union kind.
		expect(() => embeddingProviderFor('nope')).toThrow(/Unknown embedding provider/);
	});
});
