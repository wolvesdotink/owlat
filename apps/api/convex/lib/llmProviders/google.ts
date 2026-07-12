/**
 * Google (Gemini) language adapter (`@ai-sdk/google`).
 *
 * A native, hosted language provider on the LANGUAGE plane — not an
 * OpenAI-shaped shim. Uses `createGoogleGenerativeAI` so the adapter carries
 * Gemini's own request behavior. The underlying client is memoized per
 * `(baseUrl, key-fingerprint)` so repeated resolutions share one client; the
 * cache key never stores the raw key, only a non-reversible hash of it.
 *
 * Gemini's embeddings live on a separate model family (`text-embedding-004`),
 * exposed here as an OPTIONAL hosted embedding override. The two planes stay
 * decoupled: choosing Gemini for language does not select it for embeddings —
 * the embedding plane is local-by-default unless this override is configured.
 */

import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { EmbeddingModel, LanguageModel } from 'ai';
import { hostedCacheKey, memoizeClient } from './clientCache';
import type {
	EmbeddingClientConfig,
	EmbeddingProviderAdapter,
	LanguageProviderAdapter,
	ProviderClientConfig,
} from './types';

type GoogleClient = ReturnType<typeof createGoogleGenerativeAI>;

const clientCache = new Map<string, GoogleClient>();

function googleClient(cfg: ProviderClientConfig): GoogleClient {
	return memoizeClient(clientCache, hostedCacheKey(cfg), () =>
		createGoogleGenerativeAI({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl })
	);
}

export const googleLanguageAdapter: LanguageProviderAdapter<'google'> = {
	kind: 'google',
	label: 'Google (Gemini)',
	docsUrl: 'https://ai.google.dev/gemini-api/docs',
	isLocal: false,
	defaultModels: { fast: 'gemini-3.1-flash-lite', capable: 'gemini-3.5-flash' },
	buildChatModel(cfg: ProviderClientConfig, modelId: string): LanguageModel {
		return googleClient(cfg)(modelId);
	},
	validateCredentials(cfg: ProviderClientConfig): void {
		if (!cfg.apiKey) {
			throw new Error('Google (Gemini) requires an API key.');
		}
	},
};

export const googleEmbeddingAdapter: EmbeddingProviderAdapter<'google'> = {
	kind: 'google',
	label: 'Google (Gemini)',
	// `text-embedding-004` emits 768-dim vectors; the write-time guard rejects a
	// vector that won't fit the fixed index, so this is UI/docs metadata only.
	dimensions: 768,
	isLocal: false,
	defaultModel: 'text-embedding-004',
	buildEmbeddingModel(cfg: EmbeddingClientConfig): EmbeddingModel {
		return googleClient(cfg).textEmbeddingModel(cfg.modelId);
	},
	validateCredentials(cfg: EmbeddingClientConfig): void {
		if (!cfg.apiKey) {
			throw new Error('Google (Gemini) embeddings require an API key.');
		}
	},
};
