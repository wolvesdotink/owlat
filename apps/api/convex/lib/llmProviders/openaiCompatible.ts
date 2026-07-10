/**
 * OpenAI-compatible language adapter (`@ai-sdk/openai-compatible`).
 *
 * The pluggable LOCAL language backend: Ollama, vLLM, llama.cpp, or any custom
 * server that speaks the OpenAI HTTP shape. Driven by a `baseUrl` (required)
 * with an optional key. Unlike the `openai` adapter this uses the native
 * openai-compatible provider — not an OpenAI client pointed at another URL — so
 * it carries the compatible provider's own request behavior.
 *
 * The client is memoized per `(baseUrl, key-hash)`; the cache key stores only a
 * non-reversible hash of the key, never a slice of the raw secret.
 */

import type { LanguageModel } from 'ai';
import { type OpenAICompatibleClient, openAICompatibleClient } from './clientCache';
import type { LanguageProviderAdapter, ProviderClientConfig } from './types';

const clientCache = new Map<string, OpenAICompatibleClient>();

function requireBaseUrl(cfg: ProviderClientConfig): string {
	if (!cfg.baseUrl) {
		throw new Error('An OpenAI-compatible provider requires a base URL (e.g. an Ollama endpoint).');
	}
	return cfg.baseUrl;
}

function compatibleClient(cfg: ProviderClientConfig): OpenAICompatibleClient {
	return openAICompatibleClient(clientCache, 'openai-compatible', requireBaseUrl(cfg), cfg.apiKey);
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
