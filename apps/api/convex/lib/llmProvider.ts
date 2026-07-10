/**
 * LLM provider resolution for the agent pipeline.
 *
 * Resolves a language/embedding model from environment variables and exposes it
 * through `getLLMProvider(task)` / `getEmbeddingModel()` / `getLLMConfig()`.
 *
 * The env path resolves THROUGH the provider-adapter registry
 * (`./llmProviders`): it selects the `openai` adapter and builds the client via
 * that adapter — which covers OpenAI, OpenRouter, and Ollama, plus any endpoint
 * that speaks the OpenAI shape via an explicit `LLM_BASE_URL`. Stored per-org
 * config (a later plan piece) will route to other adapters through the same
 * registry; this module is the single env-fallback resolution point.
 *
 * Environment:
 *   LLM_PROVIDER        openai (default) | openrouter | ollama
 *   LLM_API_KEY | OPENROUTER_API_KEY | OPENAI_API_KEY  — first one set wins
 *   LLM_BASE_URL        explicit base-URL override (e.g. an OpenAI-compat Claude proxy)
 *   LLM_MODEL_FAST / LLM_MODEL_CAPABLE / LLM_MODEL      model IDs per tier
 *   LLM_EMBEDDING_MODEL embedding model (default text-embedding-3-small)
 */

import type { LanguageModel } from 'ai';
import { getOptional } from './env';
import {
	isTrivialUserText,
	isTrivialClassifiedMessage,
	type ClassificationSignals,
} from './llm/complexity';
import { CURRENT_EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from './constants';
import {
	embeddingProviderFor,
	languageProviderFor,
	type ProviderClientConfig,
} from './llmProviders';

/**
 * Task types map to a model tier:
 * - fast: classification, extraction, guardrails, summarization
 * - capable: drafting replies, planning multi-step actions
 */
export type LLMTask = 'classify' | 'extract' | 'guard' | 'summarize' | 'draft' | 'plan';
/** Model tiers exposed to callers. */
export type LLMTier = 'fast' | 'capable';

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

// The env fallback always resolves to the `openai` adapter — it covers OpenAI,
// OpenRouter, and Ollama via a resolved base URL, matching this module's prior
// single-`createOpenAI`-client behavior. Per-org stored config (a later plan
// piece) selects other adapters through the same registry.
const ENV_LANGUAGE_KIND = 'openai' as const;
const ENV_EMBEDDING_KIND = 'openai' as const;

/**
 * Resolve the env client config (key + base URL) for the language/embedding
 * planes, throwing the same "not configured" error as before when no key is set
 * and the provider isn't the keyless Ollama. The `'ollama'` placeholder key is
 * only ever used for that keyless case (matching prior behavior).
 */
function resolveEnvClientConfig(): ProviderClientConfig {
	const apiKey = resolveApiKey();
	const isOllama = getOptional('LLM_PROVIDER') === 'ollama';
	if (!apiKey && !isOllama) {
		throw new Error(
			'LLM API not configured. Set LLM_API_KEY, OPENROUTER_API_KEY, or OPENAI_API_KEY in Convex environment variables.'
		);
	}
	return { apiKey: apiKey ?? 'ollama', baseUrl: resolveBaseURL() };
}

function modelIdForTier(tier: LLMTier): string {
	const defaults = languageProviderFor(ENV_LANGUAGE_KIND).defaultModels;
	return tier === 'fast'
		? (getOptional('LLM_MODEL_FAST') ?? getOptional('LLM_MODEL') ?? defaults.fast)
		: (getOptional('LLM_MODEL_CAPABLE') ?? getOptional('LLM_MODEL') ?? defaults.capable);
}

/** Build the resolved language model for a concrete model id via the registry. */
function buildLanguageModel(modelId: string): LanguageModel {
	return languageProviderFor(ENV_LANGUAGE_KIND).buildChatModel(resolveEnvClientConfig(), modelId);
}

/** Resolve the language model for a given task (plugs into the AI SDK helpers). */
export function getLLMProvider(task: LLMTask = 'draft'): LanguageModel {
	return buildLanguageModel(modelIdForTier(taskTier(task)));
}

/**
 * Resolve a model for a *user-facing* task, optionally downgrading the capable
 * tier to fast when the user's input is clearly trivial and complexity routing
 * is enabled (`LLM_COMPLEXITY_ROUTING=1`, default off). Only capable-tier tasks
 * downgrade, and only obviously-trivial input does — ambiguous text keeps the
 * capable model so quality never silently drops. `userText` must be the
 * user-controlled text ONLY (never the system prompt / assembled context).
 */
export function getLLMProviderForUserText(task: LLMTask, userText: string): LanguageModel {
	const downgrade =
		getOptional('LLM_COMPLEXITY_ROUTING') === '1' &&
		taskTier(task) === 'capable' &&
		isTrivialUserText(userText);
	return buildLanguageModel(modelIdForTier(downgrade ? 'fast' : taskTier(task)));
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
export function getLLMProviderForClassifiedDraft(signals: ClassificationSignals): LanguageModel {
	const downgrade =
		getOptional('LLM_COMPLEXITY_ROUTING') === '1' && isTrivialClassifiedMessage(signals);
	return buildLanguageModel(modelIdForTier(downgrade ? 'fast' : 'capable'));
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
	return embeddingProviderFor(ENV_EMBEDDING_KIND).buildEmbeddingModel({
		...resolveEnvClientConfig(),
		modelId,
	});
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
