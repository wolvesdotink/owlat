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
 * one source. Adapters today: `openai` (hosted OpenAI, plus any endpoint that
 * speaks the OpenAI shape via an explicit base URL), `anthropic` (hosted native
 * Claude), `google` (hosted native Gemini), `openrouter` (hosted aggregator
 * fronting many upstream models via free-text, provider-prefixed ids), and
 * `openaiCompatible` (local / custom OpenAI-compatible servers: Ollama, vLLM,
 * llama.cpp).
 */
export const LANGUAGE_PROVIDER_KINDS = [
	'openai',
	'anthropic',
	'google',
	'openrouter',
	'openaiCompatible',
] as const;
export type LanguageProviderKind = (typeof LANGUAGE_PROVIDER_KINDS)[number];

/**
 * The embedding provider kinds. The embedding plane is LOCAL BY DEFAULT so
 * retrieval works under ANY language choice (incl. Anthropic, which has no
 * embeddings API):
 *   • `local` — the bundled default: a local embeddings service reached over an
 *     OpenAI-compatible `/embeddings` endpoint (e.g. Ollama `nomic-embed-text`),
 *     driven by `LOCAL_EMBEDDING_BASE_URL`. Always resolves; needs no key.
 *   • `openai` / `google` — optional HOSTED overrides (an encrypted key).
 *   • `openaiCompatible` — a custom OpenAI-compatible embeddings server
 *     (vLLM / llama.cpp / a self-hosted gateway), base-URL driven.
 * `local` is first so it is the natural default for a fresh stored config.
 */
export const EMBEDDING_PROVIDER_KINDS = ['local', 'openai', 'google', 'openaiCompatible'] as const;
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
 * Embedding provider adapter. Resolved INDEPENDENTLY of the language provider
 * (the two planes are decoupled). One adapter per provider; the `kind` narrows
 * the registry's mapped-type guard so a missing/mismatched method is a compile
 * error. `buildEmbeddingModel` is the call-time surface the resolver uses;
 * `validateCredentials` fails fast on incomplete config so a misconfigured
 * hosted embedder surfaces an actionable error rather than silently producing a
 * broken vector.
 */
export interface EmbeddingProviderAdapter<K extends EmbeddingProviderKind = EmbeddingProviderKind> {
	readonly kind: K;
	/** Human label for the settings UI. */
	readonly label: string;
	/**
	 * Native embedding width for this provider's default model. Metadata for the
	 * UI / docs — the authoritative runtime guard is `assertEmbeddingDimension`,
	 * which rejects any vector that won't fit the fixed-width index at write time.
	 */
	readonly dimensions: number;
	/** True for locally-hosted embedders (keyless, base-URL driven). */
	readonly isLocal: boolean;
	/** Default base URL for this provider (a local server's endpoint), if any. */
	readonly defaultBaseUrl?: string;
	/** Sensible default embedding model id when none is configured. */
	readonly defaultModel: string;
	/** Build the AI-SDK embedding model for a resolved config + model id. */
	buildEmbeddingModel(cfg: EmbeddingClientConfig): EmbeddingModel;
	/** Throw a descriptive error when `cfg` can't produce a working client. */
	validateCredentials(cfg: EmbeddingClientConfig): void;
}
