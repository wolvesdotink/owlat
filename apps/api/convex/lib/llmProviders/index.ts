/**
 * LLM provider adapter (module) — registries + dispatch.
 *
 * Mirrors `lib/sendProviders/index.ts` (ADR-0020). Two decoupled planes, two
 * registries:
 *   • LANGUAGE — all text generation.  `languageProviderFor(kind)`.
 *   • EMBEDDING — knowledge graph / semantic search.  `embeddingProviderFor(kind)`.
 *
 * Adding a provider is a one-adapter-file + one-registry-line change; the
 * compile-time mapped-type `satisfies` guard catches a missing/mismatched
 * method. No caller imports an adapter directly — the resolver in
 * `lib/llmProvider.ts` looks the adapter up by kind and builds through it.
 */

import { openaiEmbeddingAdapter, openaiLanguageAdapter } from './openai';
import { anthropicLanguageAdapter } from './anthropic';
import { googleEmbeddingAdapter, googleLanguageAdapter } from './google';
import { azureLanguageAdapter } from './azure';
import { openrouterLanguageAdapter } from './openrouter';
import {
	openaiCompatibleEmbeddingAdapter,
	openaiCompatibleLanguageAdapter,
} from './openaiCompatible';
import { localEmbeddingAdapter } from './local';
import type {
	EmbeddingProviderAdapter,
	EmbeddingProviderKind,
	LanguageProviderAdapter,
	LanguageProviderKind,
} from './types';

export type {
	EmbeddingClientConfig,
	EmbeddingProviderAdapter,
	EmbeddingProviderKind,
	LanguageEndpointProvenance,
	LanguageProviderAdapter,
	LanguageProviderKind,
	ProviderClientConfig,
} from './types';
export {
	EMBEDDING_PROVIDER_KINDS,
	LANGUAGE_ENDPOINT_PROVENANCES,
	LANGUAGE_PROVIDER_KINDS,
} from './types';

// ─── Language registry ─────────────────────────────────────────────────────

export const LANGUAGE_PROVIDERS = {
	openai: openaiLanguageAdapter,
	anthropic: anthropicLanguageAdapter,
	google: googleLanguageAdapter,
	azure: azureLanguageAdapter,
	openrouter: openrouterLanguageAdapter,
	openaiCompatible: openaiCompatibleLanguageAdapter,
} as const;

// Compile-time guard: each registry value must satisfy the adapter shape for
// its own kind. The mapped type pins each key to `Adapter<thatKey>`.
const _languageTypecheck: { [K in LanguageProviderKind]: LanguageProviderAdapter<K> } =
	LANGUAGE_PROVIDERS;
void _languageTypecheck;

/**
 * Look up the language adapter for a kind. Throws on unknown kinds — callers
 * validate the kind as a literal union before this is called.
 */
export function languageProviderFor<K extends LanguageProviderKind>(
	kind: K
): LanguageProviderAdapter<K> {
	const adapter = LANGUAGE_PROVIDERS[kind];
	if (!adapter) {
		throw new Error(`Unknown language provider: ${kind}`);
	}
	return adapter as unknown as LanguageProviderAdapter<K>;
}

// ─── Embedding registry ────────────────────────────────────────────────────

export const EMBEDDING_PROVIDERS = {
	local: localEmbeddingAdapter,
	openai: openaiEmbeddingAdapter,
	google: googleEmbeddingAdapter,
	openaiCompatible: openaiCompatibleEmbeddingAdapter,
} as const;

const _embeddingTypecheck: { [K in EmbeddingProviderKind]: EmbeddingProviderAdapter<K> } =
	EMBEDDING_PROVIDERS;
void _embeddingTypecheck;

/**
 * Look up the embedding adapter for a kind. Throws on unknown kinds.
 */
export function embeddingProviderFor<K extends EmbeddingProviderKind>(
	kind: K
): EmbeddingProviderAdapter<K> {
	const adapter = EMBEDDING_PROVIDERS[kind];
	if (!adapter) {
		throw new Error(`Unknown embedding provider: ${kind}`);
	}
	return adapter as unknown as EmbeddingProviderAdapter<K>;
}
