/**
 * Anthropic (Claude) language adapter (`@ai-sdk/anthropic`).
 *
 * A native, hosted language provider on the LANGUAGE plane — not an
 * OpenAI-shaped shim. Uses `createAnthropic` so the adapter carries Claude's
 * own request behavior. The underlying client is memoized per
 * `(baseUrl, key-fingerprint)` so repeated resolutions share one client; the
 * cache key never stores the raw key, only a non-reversible hash of it.
 *
 * Anthropic has NO embeddings API, so this is LANGUAGE-ONLY — there is no
 * embedding adapter here. Under an Anthropic language choice the embedding
 * plane resolves independently (local-by-default), per the two-plane brief.
 */

import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModel } from 'ai';
import { keyFingerprint, memoizeClient } from './clientCache';
import type { LanguageProviderAdapter, ProviderClientConfig } from './types';

type AnthropicClient = ReturnType<typeof createAnthropic>;

const clientCache = new Map<string, AnthropicClient>();

function anthropicClient(cfg: ProviderClientConfig): AnthropicClient {
	const cacheKey = `${cfg.baseUrl ?? ''}::${keyFingerprint(cfg.apiKey)}`;
	return memoizeClient(clientCache, cacheKey, () =>
		createAnthropic({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl })
	);
}

export const anthropicLanguageAdapter: LanguageProviderAdapter<'anthropic'> = {
	kind: 'anthropic',
	label: 'Anthropic (Claude)',
	docsUrl: 'https://docs.claude.com/en/api',
	isLocal: false,
	defaultModels: { fast: 'claude-haiku-4-5', capable: 'claude-opus-4-8' },
	buildChatModel(cfg: ProviderClientConfig, modelId: string): LanguageModel {
		return anthropicClient(cfg)(modelId);
	},
	validateCredentials(cfg: ProviderClientConfig): void {
		if (!cfg.apiKey) {
			throw new Error('Anthropic requires an API key.');
		}
	},
};
