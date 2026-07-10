/**
 * LLM provider adapter (module) — shared types.
 *
 * Two decoupled planes (per the 2026-07-10 pluggable-AI-providers plan):
 *
 *   • LANGUAGE plane — all text generation. Fully pluggable: hosted (OpenAI,
 *     Anthropic, OpenRouter, Google via an encrypted key) OR local (Ollama /
 *     vLLM / llama.cpp via a base URL and no key). A local provider is just an
 *     adapter with `isLocal: true` and a `defaultBaseUrl`.
 *   • EMBEDDING plane — knowledge graph / semantic search / quickQuery.
 *     Resolved INDEPENDENTLY of the language provider so retrieval works under
 *     any language choice.
 *
 * The registry (`./index.ts`) mirrors `lib/sendProviders` (ADR-0020): a `Kind`
 * literal union + a mapped-type `satisfies` guard so adding a provider is one
 * adapter file + one registry line, and callers stay dumb. Two registries —
 * `languageProviderFor(kind)` and `embeddingProviderFor(kind)`.
 *
 * This is the pure, isolate-safe surface (no `'use node'`): types + the client
 * config shapes the adapters build from.
 */

import type { EmbeddingModel, LanguageModel } from 'ai';

/**
 * The language provider kinds, as a runtime tuple so both the
 * `LanguageProviderKind` type and the registry's completeness guard derive from
 * one source. Three adapters today: `openai` (hosted OpenAI, plus any endpoint
 * that speaks the OpenAI shape via an explicit base URL), `anthropic` (hosted
 * native Claude), and `openaiCompatible` (local / custom OpenAI-compatible
 * servers: Ollama, vLLM, llama.cpp).
 */
export const LANGUAGE_PROVIDER_KINDS = ['openai', 'anthropic', 'openaiCompatible'] as const;
export type LanguageProviderKind = (typeof LANGUAGE_PROVIDER_KINDS)[number];

/** The embedding provider kinds. One adapter today: `openai`. */
export const EMBEDDING_PROVIDER_KINDS = ['openai'] as const;
export type EmbeddingProviderKind = (typeof EMBEDDING_PROVIDER_KINDS)[number];

/**
 * The resolved, secret-bearing client config an adapter builds a model from.
 * `apiKey` is absent for local providers; `baseUrl` overrides the adapter's
 * `defaultBaseUrl` (and is required for `openaiCompatible`).
 */
export interface ProviderClientConfig {
	/** API key for hosted providers. Absent for keyless local endpoints. */
	apiKey?: string;
	/** Base-URL override (e.g. a local Ollama/vLLM server, or an OpenAI proxy). */
	baseUrl?: string;
}

/** A {@link ProviderClientConfig} plus the concrete embedding model to build. */
export interface EmbeddingClientConfig extends ProviderClientConfig {
	/** The embedding model id (e.g. `text-embedding-3-small`). */
	modelId: string;
}

/**
 * Language provider adapter. One file per provider; the `kind` narrows the
 * registry's mapped-type guard so a missing/mismatched method is a compile
 * error. `buildChatModel` is the only call-time surface the resolver uses;
 * `validateCredentials` fails fast on incomplete config; `listModels` is an
 * optional discovery hook.
 */
export interface LanguageProviderAdapter<K extends LanguageProviderKind = LanguageProviderKind> {
	readonly kind: K;
	/** Human label for the settings UI. */
	readonly label: string;
	/** Where to point a user to get / configure credentials. */
	readonly docsUrl: string;
	/** Default base URL for this provider (a local server's endpoint), if any. */
	readonly defaultBaseUrl?: string;
	/** True for locally-hosted providers (keyless, base-URL driven). */
	readonly isLocal: boolean;
	/** Sensible per-tier default model ids when none is configured. */
	readonly defaultModels: { fast: string; capable: string };
	/** Build the AI-SDK language model for a resolved config + model id. */
	buildChatModel(cfg: ProviderClientConfig, modelId: string): LanguageModel;
	/** Throw a descriptive error when `cfg` can't produce a working client. */
	validateCredentials(cfg: ProviderClientConfig): void;
	/** Optional: list the model ids the provider exposes for this config. */
	listModels?(cfg: ProviderClientConfig): Promise<string[]>;
}

/**
 * Embedding provider adapter. Resolved independently of the language provider.
 * `dimensions` is the native output width of the adapter's default model — used
 * to guard the fixed-width vector index.
 */
export interface EmbeddingProviderAdapter<K extends EmbeddingProviderKind = EmbeddingProviderKind> {
	readonly kind: K;
	/** Native embedding width for this provider's default model. */
	readonly dimensions: number;
	/** Build the AI-SDK embedding model for a resolved config + model id. */
	buildEmbeddingModel(cfg: EmbeddingClientConfig): EmbeddingModel;
}
