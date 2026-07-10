/**
 * OpenAI-compatible language adapter (`@ai-sdk/openai-compatible`).
 *
 * The pluggable LOCAL language backend: Ollama, vLLM, llama.cpp, or any custom
 * server that speaks the OpenAI HTTP shape. Driven by a `baseUrl` (required)
 * with an optional key. Unlike the `openai` adapter this uses the native
 * openai-compatible provider — not an OpenAI client pointed at another URL — so
 * it carries the compatible provider's own request behavior.
 *
 * The client is memoized per `(baseUrl, key-fingerprint)`; the cache key stores
 * only a short non-secret fingerprint of the key.
 */

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import type { LanguageProviderAdapter, ProviderClientConfig } from './types';

type CompatibleClient = ReturnType<typeof createOpenAICompatible>;

const clientCache = new Map<string, CompatibleClient>();

/** Short, non-secret fingerprint of an API key for cache keying. */
function keyFingerprint(apiKey: string | undefined): string {
	if (!apiKey) return 'nokey';
	return `${apiKey.length}:${apiKey.slice(0, 4)}:${apiKey.slice(-4)}`;
}

function requireBaseUrl(cfg: ProviderClientConfig): string {
	if (!cfg.baseUrl) {
		throw new Error('An OpenAI-compatible provider requires a base URL (e.g. an Ollama endpoint).');
	}
	return cfg.baseUrl;
}

function compatibleClient(cfg: ProviderClientConfig): CompatibleClient {
	const baseURL = requireBaseUrl(cfg);
	const cacheKey = `${baseURL}::${keyFingerprint(cfg.apiKey)}`;
	const cached = clientCache.get(cacheKey);
	if (cached) return cached;
	const client = createOpenAICompatible({
		name: 'openai-compatible',
		baseURL,
		...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
	});
	clientCache.set(cacheKey, client);
	return client;
}

export const openaiCompatibleLanguageAdapter: LanguageProviderAdapter<'openaiCompatible'> = {
	kind: 'openaiCompatible',
	label: 'OpenAI-compatible (local / custom)',
	docsUrl: 'https://ai-sdk.dev/providers/openai-compatible-providers',
	defaultBaseUrl: 'http://localhost:11434/v1',
	isLocal: true,
	defaultModels: { fast: 'llama3.1', capable: 'llama3.1' },
	buildChatModel(cfg: ProviderClientConfig, modelId: string): LanguageModel {
		return compatibleClient(cfg)(modelId);
	},
	validateCredentials(cfg: ProviderClientConfig): void {
		requireBaseUrl(cfg);
	},
};
