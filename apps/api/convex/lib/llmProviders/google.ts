/**
 * Google (Gemini) language adapter (`@ai-sdk/google`).
 *
 * A native, hosted language provider on the LANGUAGE plane — not an
 * OpenAI-shaped shim. Uses `createGoogleGenerativeAI` so the adapter carries
 * Gemini's own request behavior. The underlying client is memoized per
 * `(baseUrl, key-fingerprint)` so repeated resolutions share one client; the
 * cache key never stores the raw key, only a non-reversible hash of it.
 *
 * Gemini's embeddings live on a separate model family (`gemini-embedding-2`),
 * exposed here as an OPTIONAL hosted embedding override. The two planes stay
 * decoupled: choosing Gemini for language does not select it for embeddings —
 * the embedding plane is local-by-default unless this override is configured.
 */

import { LANGUAGE_MODEL_CATALOG, GOOGLE_EMBEDDING_DEFAULT } from '@owlat/shared/aiModelCatalog';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { wrapEmbeddingModel, type EmbeddingModel, type LanguageModel } from 'ai';
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
	defaultModels: LANGUAGE_MODEL_CATALOG.google.defaults,
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
	dimensions: GOOGLE_EMBEDDING_DEFAULT.dimensions,
	isLocal: false,
	defaultModel: GOOGLE_EMBEDDING_DEFAULT.model,
	buildEmbeddingModel(cfg: EmbeddingClientConfig): EmbeddingModel {
		const model = googleClient(cfg).textEmbeddingModel(cfg.modelId);
		if (cfg.modelId !== GOOGLE_EMBEDDING_DEFAULT.model) return model;
		const bounded = wrapEmbeddingModel({
			model,
			middleware: {
				specificationVersion: 'v3',
				transformParams: async ({ params }) => ({
					...params,
					providerOptions: {
						...params.providerOptions,
						google: {
							...params.providerOptions?.['google'],
							outputDimensionality: GOOGLE_EMBEDDING_DEFAULT.dimensions,
						},
					},
				}),
			},
		});
		// Keep one vector per input; the SDK's multi-value path uses the legacy
		// batchEmbedContents endpoint. Embedding 2 supports embedContent instead.
		return {
			specificationVersion: bounded.specificationVersion,
			provider: bounded.provider,
			modelId: bounded.modelId,
			maxEmbeddingsPerCall: 1,
			supportsParallelCalls: bounded.supportsParallelCalls,
			doEmbed: bounded.doEmbed.bind(bounded),
		};
	},
	validateCredentials(cfg: EmbeddingClientConfig): void {
		if (!cfg.apiKey) {
			throw new Error('Google (Gemini) embeddings require an API key.');
		}
	},
};
