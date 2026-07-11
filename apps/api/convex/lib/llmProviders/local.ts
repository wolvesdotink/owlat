/**
 * Local embedding adapter — the DEFAULT of the embedding plane.
 *
 * The embedding plane is LOCAL BY DEFAULT so retrieval (knowledge graph /
 * semantic file search / quickQuery) works under ANY language choice — including
 * Anthropic, which has no embeddings API. This adapter reaches a local
 * embeddings SERVICE over an OpenAI-compatible `/embeddings` endpoint (e.g.
 * Ollama serving `nomic-embed-text`), driven by `LOCAL_EMBEDDING_BASE_URL` (the
 * resolver supplies the base URL; this stays pure). Nothing is bundled INTO the
 * Convex isolate — no transformers.js / ONNX weight — so it fits the self-host
 * installer and adds no cold-start cost.
 *
 * There is no local LANGUAGE adapter counterpart in this file: local language
 * generation is the general `openaiCompatible` adapter. The local plane is
 * embedding-only, hence its own module.
 *
 * NOTE ON DIMENSIONS: the vector index is fixed-width (`EMBEDDING_DIMENSIONS`).
 * `nomic-embed-text` emits 768-dim vectors, so a self-hoster pointing this at
 * that model must either run a model whose width matches the index or adjust
 * `EMBEDDING_DIMENSIONS` and re-index. `assertEmbeddingDimension` raises an
 * actionable error at write time rather than storing a mismatched vector.
 */

import type { EmbeddingModel } from 'ai';
import { type OpenAICompatibleClient, openAICompatibleClient } from './clientCache';
import type { EmbeddingClientConfig, EmbeddingProviderAdapter } from './types';

const clientCache = new Map<string, OpenAICompatibleClient>();

function requireBaseUrl(cfg: EmbeddingClientConfig): string {
	if (!cfg.baseUrl) {
		throw new Error(
			'The local embedder requires a base URL. Set LOCAL_EMBEDDING_BASE_URL (e.g. an Ollama endpoint) in the Convex environment.'
		);
	}
	return cfg.baseUrl;
}

export const localEmbeddingAdapter: EmbeddingProviderAdapter<'local'> = {
	kind: 'local',
	label: 'Local (self-hosted)',
	// nomic-embed-text emits 768-dim vectors. Metadata only — the authoritative
	// runtime guard is `assertEmbeddingDimension` against the fixed index width.
	dimensions: 768,
	isLocal: true,
	defaultBaseUrl: 'http://localhost:11434/v1',
	defaultModel: 'nomic-embed-text',
	buildEmbeddingModel(cfg: EmbeddingClientConfig): EmbeddingModel {
		return openAICompatibleClient(
			clientCache,
			'local-embedding',
			requireBaseUrl(cfg),
			cfg.apiKey
		).textEmbeddingModel(cfg.modelId);
	},
	validateCredentials(cfg: EmbeddingClientConfig): void {
		requireBaseUrl(cfg);
	},
};
