/**
 * OpenAI language + embedding adapters (`@ai-sdk/openai`).
 *
 * Covers hosted OpenAI and any endpoint that speaks the OpenAI shape through an
 * explicit `baseUrl` (OpenRouter, an OpenAI-compatible proxy). The underlying
 * `createOpenAI` client is memoized per `(baseUrl, key-fingerprint)` so repeated
 * resolutions — and the language + embedding planes for the same config — share
 * one client, exactly like the single cached client this replaced. The cache
 * key never stores the raw key, only a non-reversible hash of it.
 */

import { createOpenAI } from '@ai-sdk/openai';
import type { EmbeddingModel, LanguageModel } from 'ai';
import { CURRENT_EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from '../constants';
import { hostedCacheKey, memoizeClient } from './clientCache';
import type {
	EmbeddingClientConfig,
	EmbeddingProviderAdapter,
	LanguageProviderAdapter,
	ProviderClientConfig,
} from './types';

type OpenAIClient = ReturnType<typeof createOpenAI>;

const clientCache = new Map<string, OpenAIClient>();

function openaiClient(cfg: ProviderClientConfig): OpenAIClient {
	return memoizeClient(clientCache, hostedCacheKey(cfg), () =>
		createOpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl })
	);
}

export const openaiLanguageAdapter: LanguageProviderAdapter<'openai'> = {
	kind: 'openai',
	label: 'OpenAI',
	docsUrl: 'https://platform.openai.com/docs/api-reference',
	isLocal: false,
	defaultModels: { fast: 'gpt-4o-mini', capable: 'gpt-4o' },
	buildChatModel(cfg: ProviderClientConfig, modelId: string): LanguageModel {
		return openaiClient(cfg)(modelId);
	},
	validateCredentials(cfg: ProviderClientConfig): void {
		if (!cfg.apiKey) {
			throw new Error('OpenAI requires an API key.');
		}
	},
};

export const openaiEmbeddingAdapter: EmbeddingProviderAdapter<'openai'> = {
	kind: 'openai',
	label: 'OpenAI',
	dimensions: EMBEDDING_DIMENSIONS,
	isLocal: false,
	defaultModel: CURRENT_EMBEDDING_MODEL,
	buildEmbeddingModel(cfg: EmbeddingClientConfig): EmbeddingModel {
		return openaiClient(cfg).embedding(cfg.modelId);
	},
	validateCredentials(cfg: EmbeddingClientConfig): void {
		if (!cfg.apiKey) {
			throw new Error('OpenAI embeddings require an API key.');
		}
	},
};
