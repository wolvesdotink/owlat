/**
 * LLM provider resolution for the agent pipeline.
 *
 * Resolves an OpenAI-compatible language/embedding model from environment
 * variables and exposes it through `getLLMProvider(task)` /
 * `getEmbeddingModel()` / `getLLMConfig()`. "OpenAI-compatible" covers OpenAI,
 * OpenRouter, and Ollama — plus any Claude/other endpoint that speaks the
 * OpenAI shape via an explicit `LLM_BASE_URL`.
 *
 * Environment:
 *   LLM_PROVIDER        openai (default) | openrouter | ollama
 *   LLM_API_KEY | OPENROUTER_API_KEY | OPENAI_API_KEY  — first one set wins
 *   LLM_BASE_URL        explicit base-URL override (e.g. an OpenAI-compat Claude proxy)
 *   LLM_MODEL_FAST / LLM_MODEL_CAPABLE / LLM_MODEL      model IDs per tier
 *   LLM_EMBEDDING_MODEL embedding model (default text-embedding-3-small)
 */

import { createOpenAI } from '@ai-sdk/openai';
import { getOptional } from './env';
import {
	isTrivialUserText,
	isTrivialClassifiedMessage,
	type ClassificationSignals,
} from './llm/complexity';
import { CURRENT_EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from './constants';

/**
 * Task types map to a model tier:
 * - fast: classification, extraction, guardrails, summarization
 * - capable: drafting replies, planning multi-step actions
 */
export type LLMTask = 'classify' | 'extract' | 'guard' | 'summarize' | 'draft' | 'plan';
/** Model tiers exposed to callers. */
export type LLMTier = 'fast' | 'capable';

const DEFAULT_MODEL_FAST = 'gpt-4o-mini';
const DEFAULT_MODEL_CAPABLE = 'gpt-4o';
// The default embedding model is the one stamped on rows as provenance
// (CURRENT_EMBEDDING_MODEL). Single-sourcing it here keeps the resolved model
// and the stamped model from drifting, preserving the schema's "re-embed when
// the model changes" invariant.
const DEFAULT_EMBEDDING_MODEL = CURRENT_EMBEDDING_MODEL;

function taskTier(task: LLMTask): LLMTier {
	return task === 'draft' || task === 'plan' ? 'capable' : 'fast';
}

function resolveApiKey(): string | undefined {
	return (
		getOptional('LLM_API_KEY') || getOptional('OPENROUTER_API_KEY') || getOptional('OPENAI_API_KEY')
	);
}

function resolveBaseURL(): string | undefined {
	const explicit = getOptional('LLM_BASE_URL');
	if (explicit) return explicit;
	switch (getOptional('LLM_PROVIDER')) {
		case 'openrouter':
			return 'https://openrouter.ai/api/v1';
		case 'ollama':
			return 'http://ollama:11434/v1';
		default:
			return undefined;
	}
}

// Cached per process; tests reset module state via vi.resetModules().
let cachedClient: ReturnType<typeof createOpenAI> | null = null;

function getClient() {
	const apiKey = resolveApiKey();
	const isOllama = getOptional('LLM_PROVIDER') === 'ollama';
	if (!apiKey && !isOllama) {
		throw new Error(
			'LLM API not configured. Set LLM_API_KEY, OPENROUTER_API_KEY, or OPENAI_API_KEY in Convex environment variables.'
		);
	}
	if (!cachedClient) {
		cachedClient = createOpenAI({ apiKey: apiKey ?? 'ollama', baseURL: resolveBaseURL() });
	}
	return cachedClient;
}

function modelIdForTier(tier: LLMTier): string {
	return tier === 'fast'
		? (getOptional('LLM_MODEL_FAST') ?? getOptional('LLM_MODEL') ?? DEFAULT_MODEL_FAST)
		: (getOptional('LLM_MODEL_CAPABLE') ?? getOptional('LLM_MODEL') ?? DEFAULT_MODEL_CAPABLE);
}

/** Resolve the language model for a given task (plugs into the AI SDK helpers). */
export function getLLMProvider(task: LLMTask = 'draft') {
	return getClient()(modelIdForTier(taskTier(task)));
}

/**
 * Resolve a model for a *user-facing* task, optionally downgrading the capable
 * tier to fast when the user's input is clearly trivial and complexity routing
 * is enabled (`LLM_COMPLEXITY_ROUTING=1`, default off). Only capable-tier tasks
 * downgrade, and only obviously-trivial input does — ambiguous text keeps the
 * capable model so quality never silently drops. `userText` must be the
 * user-controlled text ONLY (never the system prompt / assembled context).
 */
export function getLLMProviderForUserText(task: LLMTask, userText: string) {
	const downgrade =
		getOptional('LLM_COMPLEXITY_ROUTING') === '1' &&
		taskTier(task) === 'capable' &&
		isTrivialUserText(userText);
	return getClient()(modelIdForTier(downgrade ? 'fast' : taskTier(task)));
}

/**
 * Resolve the model for the inbound agent's `draft` step, downgrading the
 * capable tier to fast when the message is clearly trivial AND complexity
 * routing is enabled (`LLM_COMPLEXITY_ROUTING=1`, default off). Unlike
 * {@link getLLMProviderForUserText}, triviality is judged from the TRUSTED,
 * sanitized classifier signals only — never the attacker-controlled email body —
 * so a crafted "thanks!"-looking inbound can't force a cheaper, lower-quality
 * draft. Ambiguous / important / low-confidence messages keep the capable tier,
 * and when routing is off this is exactly today's single-tier behaviour.
 */
export function getLLMProviderForClassifiedDraft(signals: ClassificationSignals) {
	const downgrade =
		getOptional('LLM_COMPLEXITY_ROUTING') === '1' && isTrivialClassifiedMessage(signals);
	return getClient()(modelIdForTier(downgrade ? 'fast' : 'capable'));
}

// Known embedding models and their native output width. Used to fail fast when
// LLM_EMBEDDING_MODEL is set to a model whose vectors won't fit the fixed
// EMBEDDING_DIMENSIONS-wide vector index. Unknown/custom (e.g. Ollama) models
// aren't listed — they're caught at write time by assertEmbeddingDimension.
const KNOWN_EMBEDDING_DIMENSIONS: Record<string, number> = {
	'text-embedding-3-small': 1536,
	'text-embedding-ada-002': 1536,
	'text-embedding-3-large': 3072,
};

/** Resolve the embedding model used by knowledge graph / semantic file search. */
export function getEmbeddingModel() {
	const modelId = getOptional('LLM_EMBEDDING_MODEL') ?? DEFAULT_EMBEDDING_MODEL;
	const known = KNOWN_EMBEDDING_DIMENSIONS[modelId];
	if (known !== undefined && known !== EMBEDDING_DIMENSIONS) {
		throw new Error(
			`LLM_EMBEDDING_MODEL='${modelId}' produces ${known}-dimensional vectors, but the ` +
				`vector index is fixed at ${EMBEDDING_DIMENSIONS}. Set a ${EMBEDDING_DIMENSIONS}-dim ` +
				`embedding model (e.g. text-embedding-3-small) or change the schema vectorIndex dimensions.`
		);
	}
	return getClient().embedding(modelId);
}

/**
 * Throw if an embedding vector won't fit the fixed-width vector index. Catches
 * custom / unknown models whose dimension can't be validated at config time —
 * without this a wrong-width vector is silently stored and breaks every vector
 * search (or surfaces as an opaque Convex vectorIndex error).
 */
export function assertEmbeddingDimension(embedding: ArrayLike<number>): void {
	if (embedding.length !== EMBEDDING_DIMENSIONS) {
		throw new Error(
			`Embedding model produced a ${embedding.length}-dimensional vector but the vector ` +
				`index requires ${EMBEDDING_DIMENSIONS}. Set LLM_EMBEDDING_MODEL to a ${EMBEDDING_DIMENSIONS}-dim model.`
		);
	}
}

/** Snapshot of the active LLM configuration for logging / debugging (no secrets). */
export function getLLMConfig() {
	return {
		provider: getOptional('LLM_PROVIDER') ?? 'openai',
		modelFast: modelIdForTier('fast'),
		modelCapable: modelIdForTier('capable'),
		embeddingModel: getOptional('LLM_EMBEDDING_MODEL') ?? DEFAULT_EMBEDDING_MODEL,
		baseURL: resolveBaseURL(),
		hasApiKey: !!resolveApiKey(),
	};
}
