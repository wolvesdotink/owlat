/**
 * OpenRouter language adapter.
 *
 * OpenRouter is a hosted aggregator that fronts many upstream models behind one
 * OpenAI-compatible endpoint, so this adapter builds through
 * `@ai-sdk/openai-compatible` pointed at `https://openrouter.ai/api/v1` with a
 * hosted API key. (The dedicated `@openrouter/ai-sdk-provider` is not in the
 * repo's `ai` catalog; the OpenAI-compatible shape is the supported way to
 * reach OpenRouter and keeps the dependency surface small.)
 *
 * Model ids are free-text and provider-prefixed — e.g. `anthropic/claude-opus-4-8`,
 * `openai/gpt-4o-mini` — so there is no fixed `defaultModels` catalog to price
 * deterministically. `listModels` hits OpenRouter's public `/models` endpoint so
 * a settings UI can populate a picker. Pricing for OpenRouter ids degrades
 * gracefully: the usage cost table matches on the embedded upstream id via its
 * `includes` fallback, and an unmatched id is flagged `estimated` — never a throw.
 *
 * The client is memoized per `(baseUrl, key-fingerprint)`; the cache key stores
 * only a non-reversible hash of the key, never a slice of the raw secret.
 */

import type { LanguageModel } from 'ai';
import { type OpenAICompatibleClient, openAICompatibleClient } from './clientCache';
import type { LanguageProviderAdapter, ProviderClientConfig } from './types';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

const clientCache = new Map<string, OpenAICompatibleClient>();

/** The endpoint to reach: an explicit override, else OpenRouter's hosted URL. */
function openrouterBaseUrl(cfg: ProviderClientConfig): string {
	return cfg.baseUrl ?? OPENROUTER_BASE_URL;
}

function openrouterClient(cfg: ProviderClientConfig): OpenAICompatibleClient {
	return openAICompatibleClient(clientCache, 'openrouter', openrouterBaseUrl(cfg), cfg.apiKey);
}

/**
 * Extract the model ids from an OpenRouter `/models` payload
 * (`{ data: [{ id, … }] }`), defensively: anything off-shape is skipped rather
 * than throwing, so a malformed entry can't sink the whole listing.
 */
export function parseOpenRouterModelIds(body: unknown): string[] {
	if (typeof body !== 'object' || body === null || !('data' in body)) {
		return [];
	}
	const data = (body as { data: unknown }).data;
	if (!Array.isArray(data)) {
		return [];
	}
	const ids: string[] = [];
	for (const entry of data) {
		if (typeof entry === 'object' && entry !== null && 'id' in entry) {
			const id = (entry as { id: unknown }).id;
			if (typeof id === 'string' && id.length > 0) {
				ids.push(id);
			}
		}
	}
	return ids;
}

export const openrouterLanguageAdapter: LanguageProviderAdapter<'openrouter'> = {
	kind: 'openrouter',
	label: 'OpenRouter',
	docsUrl: 'https://openrouter.ai/docs',
	isLocal: false,
	// Free-text, provider-prefixed ids; these are sensible starting points a user
	// can swap for any model the /models listing exposes.
	defaultModels: { fast: 'openai/gpt-4o-mini', capable: 'anthropic/claude-sonnet-4-5' },
	buildChatModel(cfg: ProviderClientConfig, modelId: string): LanguageModel {
		return openrouterClient(cfg)(modelId);
	},
	validateCredentials(cfg: ProviderClientConfig): void {
		if (!cfg.apiKey) {
			throw new Error('OpenRouter requires an API key.');
		}
	},
	async listModels(cfg: ProviderClientConfig): Promise<string[]> {
		const res = await fetch(`${openrouterBaseUrl(cfg)}/models`, {
			headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {},
		});
		if (!res.ok) {
			throw new Error(`OpenRouter model listing failed (HTTP ${res.status}).`);
		}
		const body: unknown = await res.json();
		return parseOpenRouterModelIds(body);
	},
};
