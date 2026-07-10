/**
 * Google (Gemini) language adapter (`@ai-sdk/google`).
 *
 * A native, hosted language provider on the LANGUAGE plane — not an
 * OpenAI-shaped shim. Uses `createGoogleGenerativeAI` so the adapter carries
 * Gemini's own request behavior. The underlying client is memoized per
 * `(baseUrl, key-fingerprint)` so repeated resolutions share one client; the
 * cache key never stores the raw key, only a non-reversible hash of it.
 *
 * Gemini's embeddings live on a separate model family; this adapter is
 * LANGUAGE-ONLY per the two-plane brief. Under a Google language choice the
 * embedding plane still resolves independently (local-by-default).
 */

import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { LanguageModel } from 'ai';
import { hostedCacheKey, memoizeClient } from './clientCache';
import type { LanguageProviderAdapter, ProviderClientConfig } from './types';

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
	defaultModels: { fast: 'gemini-2.5-flash', capable: 'gemini-2.5-pro' },
	buildChatModel(cfg: ProviderClientConfig, modelId: string): LanguageModel {
		return googleClient(cfg)(modelId);
	},
	validateCredentials(cfg: ProviderClientConfig): void {
		if (!cfg.apiKey) {
			throw new Error('Google (Gemini) requires an API key.');
		}
	},
};
