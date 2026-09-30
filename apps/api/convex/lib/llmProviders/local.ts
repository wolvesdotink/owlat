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
 * `nomic-embed-text` emits 768-dim vectors; `toIndexVector` zero-pads them to
 * the index width, which leaves cosine similarity unchanged.
 *
 * The default endpoint is the `ollama` service the self-host compose file ships
 * under the `ai` profile, which also pulls this model on boot (`ollama-models`).
 * A Convex backend running outside Docker sets LOCAL_EMBEDDING_BASE_URL instead.
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
	// nomic-embed-text emits 768-dim vectors. Metadata only — `toIndexVector`
	// fits every vector to the fixed index width at runtime.
	dimensions: 768,
	isLocal: true,
	// `localhost` is the Convex container itself, where nothing listens.
	defaultBaseUrl: 'http://ollama:11434/v1',
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
