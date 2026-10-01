/**
 * LLM provider resolution for the agent pipeline.
 *
 * The ONE resolution point for the LANGUAGE plane (per the 2026-07-10 pluggable
 * AI-providers plan). `resolveAiConfig(ctx)` produces a typed
 * {@link ResolvedProviderConfig} for both planes from a dual source:
 *
 *   • STORED per-org config (`aiProviderConfig` row) WINS when present. The
 *     language key is decrypted ONLY for hosted providers, and ONLY inside the
 *     sibling `'use node'` action `aiProviderConfigActions._decryptSecretEnvelope`
 *     (the plaintext key never crosses to a query result or the client).
 *   • ENV `LLM_*` is the deployment fallback when no row exists — self-hosters
 *     who set `LLM_*` keep working with zero UI.
 *
 * The config row is memoized in-process (`./llmProviders/storedConfigCache`) and
 * each plane's key is decrypted only when that plane is asked for (a text call
 * never decrypts the embedding key), then kept for five minutes. The row itself
 * is re-read every 30 s, and a changed row drops the cached keys. Both
 * paths resolve through the provider-adapter registry (`./llmProviders`), where
 * a `kind` selects the adapter that builds the client.
 *
 * Language models and embeddings resolve through the same `resolveAiConfig(ctx)`
 * point, while the two planes remain decoupled:
 *
 *   • The embedding plane is LOCAL BY DEFAULT (an OpenAI-compatible sidecar via
 *     `LOCAL_EMBEDDING_BASE_URL`) so retrieval works under ANY language choice,
 *     including Anthropic (which has no embeddings API). Optional hosted
 *     embedders (`openai` / `google`) are overrides with their own encrypted key.
 *   • The env `LLM_EMBEDDING_MODEL` (through the `openai` adapter) remains the
 *     deployment fallback when no stored row exists — resolution order is:
 *     stored hosted embedder (decrypted key) → stored local default → env.
 *
 * A misconfigured hosted embedder surfaces an actionable error at resolve time
 * (never a silent empty/zero vector); changing the embedder bumps the stored
 * `embeddingModelVersion` so a re-index can be prompted, and every vector is
 * fitted to the index width by `toIndexVector` (narrower ones zero-padded).
 *
 * Environment (fallback only):
 *   LLM_PROVIDER        openai (default) | openrouter | ollama
 *   LLM_API_KEY | OPENROUTER_API_KEY | OPENAI_API_KEY  — first one set wins
 *   LLM_BASE_URL        explicit base-URL override (e.g. an OpenAI-compat proxy)
 *   LLM_MODEL_FAST / LLM_MODEL_CAPABLE / LLM_MODEL      model IDs per tier
 *   LLM_EMBEDDING_MODEL embedding model (default text-embedding-3-small)
 *   LOCAL_EMBEDDING_BASE_URL / LOCAL_EMBEDDING_MODEL    local embedder sidecar
 */

import type { EmbeddingModel, LanguageModel } from 'ai';
import type { ActionCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
import { getOptional } from './env';
import { AiNotConfiguredError, envLlmApiKey, isEnvAiProviderConfigured } from './aiNotConfigured';
import {
	isTrivialUserText,
	isTrivialClassifiedMessage,
	type ClassificationSignals,
} from './llm/complexity';
import { CURRENT_EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from './constants';
import {
	classifyEnvLanguageEndpoint,
	classifyStoredLanguageEndpoint,
	embeddingProviderFor,
	languageProviderFor,
	type LanguageEndpointProvenance,
	type LanguageProviderKind,
	type ProviderClientConfig,
	type ResolvedLanguageModel,
} from './llmProviders';
import type { StoredEmbeddingProviderKind } from './validators/aiProviderConfig';
import {
	invalidateAiConfigCache,
	loadConfigEntry,
	planeKey,
} from './llmProviders/storedConfigCache';

export { invalidateAiConfigCache } from './llmProviders/storedConfigCache';

/**
 * Task types map to a model tier:
 * - fast: classification, extraction, guardrails, summarization, short
 *   suggested-reply options (a user is waiting on them, and 1–2 sentence
 *   replies do not need the capable model)
 * - capable: drafting replies, planning multi-step actions
 */
export type LLMTask = 'classify' | 'extract' | 'guard' | 'summarize' | 'suggest' | 'draft' | 'plan';
/** Model tiers exposed to callers. */
type LLMTier = 'fast' | 'capable';

/** The resolved language plane — kind + secret-bearing client + per-tier models. */
interface ResolvedLanguagePlane {
	readonly kind: LanguageProviderKind;
	readonly endpointProvenance: LanguageEndpointProvenance;
	/** Decrypted client config (apiKey present only for hosted providers). */
	readonly clientConfig: ProviderClientConfig;
	readonly models: { readonly fast: string; readonly capable: string };
}

/**
 * The resolved embedding plane — resolved INDEPENDENTLY of the language plane
 * ({@link resolveEmbeddingModel} builds the AI-SDK model from it). `clientConfig`
 * carries the local sidecar base URL or the decrypted hosted-embedder key;
 * `modelVersion` is the stored dimension-guard version (absent for env fallback).
 */
interface ResolvedEmbeddingPlane {
	readonly kind: StoredEmbeddingProviderKind;
	readonly modelId: string;
	/** Base URL (local sidecar) / decrypted key (hosted). Empty for env-keyless. */
	readonly clientConfig: ProviderClientConfig;
	/** Stored `embeddingModelVersion` guard; `undefined` under the env fallback. */
	readonly modelVersion?: number;
}

/** The dual-source-resolved AI config for both planes. */
interface ResolvedProviderConfig {
	readonly language: ResolvedLanguagePlane;
	readonly embedding: ResolvedEmbeddingPlane;
	/** Whether the config came from the stored per-org row or the env fallback. */
	readonly source: 'stored' | 'env';
	/** The stored row's `updatedAt`, when resolved from stored config. */
	readonly updatedAt?: number;
}

// The default embedding model is the one stamped on rows as provenance
// (CURRENT_EMBEDDING_MODEL). Single-sourcing it here keeps the resolved model
// and the stamped model from drifting, preserving the schema's "re-embed when
// the model changes" invariant.
const DEFAULT_EMBEDDING_MODEL = CURRENT_EMBEDDING_MODEL;

function taskTier(task: LLMTask): LLMTier {
	return task === 'draft' || task === 'plan' ? 'capable' : 'fast';
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
// single-`createOpenAI`-client behavior. Per-org stored config selects other
// adapters through the same registry.
const ENV_LANGUAGE_KIND = 'openai' as const;
const ENV_EMBEDDING_KIND = 'openai' as const;

/**
 * Resolve the env client config (key + base URL) for the language/embedding
 * planes, throwing the same "not configured" error as before when no key is set
 * and the provider isn't the keyless Ollama. The `'ollama'` placeholder key is
 * only ever used for that keyless case (matching prior behavior).
 */
function resolveEnvClientConfig(): ProviderClientConfig {
	if (!isEnvAiProviderConfigured()) throw new AiNotConfiguredError();
	const apiKey = envLlmApiKey();
	return { apiKey: apiKey ?? 'ollama', baseUrl: resolveBaseURL() };
}

function modelIdForTier(tier: LLMTier): string {
	const defaults = languageProviderFor(ENV_LANGUAGE_KIND).defaultModels;
	return tier === 'fast'
		? (getOptional('LLM_MODEL_FAST') ?? getOptional('LLM_MODEL') ?? defaults.fast)
		: (getOptional('LLM_MODEL_CAPABLE') ?? getOptional('LLM_MODEL') ?? defaults.capable);
}

/**
 * Resolve the embedding plane for a stored kind. The two planes are decoupled,
 * so this depends only on the embedding selection — never the language provider.
 * Local / custom-compatible embedders draw their base URL from
 * `LOCAL_EMBEDDING_BASE_URL` (falling back to the adapter's default endpoint) and
 * their model from `LOCAL_EMBEDDING_MODEL`; hosted embedders carry the decrypted
 * `hostedKey`. `storedModel` (the admin's explicit choice) always wins.
 */
function resolveEmbeddingPlane(
	kind: StoredEmbeddingProviderKind,
	storedModel: string | undefined,
	hostedKey: string | undefined,
	modelVersion: number | undefined
): ResolvedEmbeddingPlane {
	const adapter = embeddingProviderFor(kind);
	const modelDefault = adapter.isLocal
		? (getOptional('LOCAL_EMBEDDING_MODEL') ?? adapter.defaultModel)
		: adapter.defaultModel;
	const clientConfig: ProviderClientConfig = adapter.isLocal
		? { baseUrl: getOptional('LOCAL_EMBEDDING_BASE_URL') ?? adapter.defaultBaseUrl }
		: { apiKey: hostedKey };
	return { kind, modelId: storedModel ?? modelDefault, clientConfig, modelVersion };
}

/** Resolve both planes from the env `LLM_*` fallback (no stored row present). */
function resolveEnvProviderConfig(): ResolvedProviderConfig {
	// The language and embedding planes share the env key/base-URL here (the
	// prior single-client behavior); resolve it once.
	const clientConfig = resolveEnvClientConfig();
	return {
		source: 'env',
		language: {
			kind: ENV_LANGUAGE_KIND,
			endpointProvenance: classifyEnvLanguageEndpoint(
				getOptional('LLM_PROVIDER'),
				Boolean(getOptional('LLM_BASE_URL'))
			),
			clientConfig,
			models: { fast: modelIdForTier('fast'), capable: modelIdForTier('capable') },
		},
		embedding: {
			kind: ENV_EMBEDDING_KIND,
			modelId: getOptional('LLM_EMBEDDING_MODEL') ?? DEFAULT_EMBEDDING_MODEL,
			clientConfig,
		},
	};
}

/**
 * Map a stored config row into a resolved config. `languageKey` / `embeddingKey`
 * are the decrypted provider keys (already fetched via the Node decrypt action
 * for hosted providers, `undefined` for local/keyless ones). The embedding plane
 * is resolved INDEPENDENTLY of the language plane.
 */
export function buildStoredProviderConfig(
	row: Doc<'aiProviderConfig'>,
	languageKey: string | undefined,
	embeddingKey: string | undefined
): ResolvedProviderConfig {
	const adapter = languageProviderFor(row.languageProviderKind);
	return {
		source: 'stored',
		updatedAt: row.updatedAt,
		language: {
			kind: row.languageProviderKind,
			endpointProvenance: classifyStoredLanguageEndpoint(
				row.languageProviderKind,
				row.languageBaseUrl !== undefined
			),
			clientConfig: { apiKey: languageKey, baseUrl: row.languageBaseUrl ?? adapter.defaultBaseUrl },
			models: { fast: row.modelFast, capable: row.modelCapable },
		},
		embedding: resolveEmbeddingPlane(
			row.embeddingProviderKind,
			row.embeddingModel,
			embeddingKey,
			row.embeddingModelVersion
		),
	};
}

/**
 * Resolve the org's AI config for both planes: the stored per-org row WINS when
 * present, otherwise the env `LLM_*` fallback. The two planes decrypt their own
 * keys, in parallel — a hosted language provider and a hosted embedder can each
 * carry a distinct key. Callers that need one plane use the plane resolvers
 * below, which decrypt only that plane's key.
 */
export async function resolveAiConfig(ctx: ActionCtx): Promise<ResolvedProviderConfig> {
	const entry = await loadConfigEntry(ctx);
	if (!entry.row) return resolveEnvProviderConfig();
	const [languageKey, embeddingKey] = await Promise.all([
		planeKey(ctx, entry, 'language'),
		planeKey(ctx, entry, 'embedding'),
	]);
	return buildStoredProviderConfig(entry.row, languageKey, embeddingKey);
}

/** The language plane alone: never decrypts the embedding key. */
async function resolveLanguagePlane(ctx: ActionCtx): Promise<ResolvedLanguagePlane> {
	const entry = await loadConfigEntry(ctx);
	if (!entry.row) return resolveEnvProviderConfig().language;
	const languageKey = await planeKey(ctx, entry, 'language');
	return buildStoredProviderConfig(entry.row, languageKey, undefined).language;
}

/** The embedding plane alone: never decrypts the language key. */
async function resolveEmbeddingPlaneConfig(ctx: ActionCtx): Promise<ResolvedEmbeddingPlane> {
	const entry = await loadConfigEntry(ctx);
	if (!entry.row) return resolveEnvProviderConfig().embedding;
	const embeddingKey = await planeKey(ctx, entry, 'embedding');
	return buildStoredProviderConfig(entry.row, undefined, embeddingKey).embedding;
}

/** Test-only: drop the in-process config cache so a fresh resolution runs. */
export const __resetAiConfigCacheForTests = invalidateAiConfigCache;

/** Build a model together with the trusted, secret-free resolution metadata. */
function resolveLanguageModelFromPlane(
	language: ResolvedLanguagePlane,
	tier: LLMTier
): ResolvedLanguageModel {
	const modelId = tier === 'fast' ? language.models.fast : language.models.capable;
	return Object.freeze({
		model: languageProviderFor(language.kind).buildChatModel(language.clientConfig, modelId),
		modelId,
		endpointProvenance: language.endpointProvenance,
	});
}

/** Resolve a language model with endpoint identity for hard-budget consumers. */
export async function resolveLanguageModelWithProvenance(
	ctx: ActionCtx,
	task: LLMTask = 'draft'
): Promise<ResolvedLanguageModel> {
	return resolveLanguageModelFromPlane(await resolveLanguagePlane(ctx), taskTier(task));
}

/** Resolve the language model for a given task (plugs into the AI SDK helpers). */
export async function resolveLanguageModel(
	ctx: ActionCtx,
	task: LLMTask = 'draft'
): Promise<LanguageModel> {
	return (await resolveLanguageModelWithProvenance(ctx, task)).model;
}

/**
 * Resolve a model for a *user-facing* task, optionally downgrading the capable
 * tier to fast when the user's input is clearly trivial and complexity routing
 * is enabled (`LLM_COMPLEXITY_ROUTING=1`, default off). Only capable-tier tasks
 * downgrade, and only obviously-trivial input does — ambiguous text keeps the
 * capable model so quality never silently drops. `userText` must be the
 * user-controlled text ONLY (never the system prompt / assembled context).
 */
export async function resolveLanguageModelForUserText(
	ctx: ActionCtx,
	task: LLMTask,
	userText: string
): Promise<LanguageModel> {
	const language = await resolveLanguagePlane(ctx);
	const downgrade =
		getOptional('LLM_COMPLEXITY_ROUTING') === '1' &&
		taskTier(task) === 'capable' &&
		isTrivialUserText(userText);
	return resolveLanguageModelFromPlane(language, downgrade ? 'fast' : taskTier(task)).model;
}

/**
 * Resolve the model for the inbound agent's `draft` step, downgrading the
 * capable tier to fast when the message is clearly trivial AND complexity
 * routing is enabled (`LLM_COMPLEXITY_ROUTING=1`, default off). Unlike
 * {@link resolveLanguageModelForUserText}, triviality is judged from the
 * TRUSTED, sanitized classifier signals only — never the attacker-controlled
 * email body — so a crafted "thanks!"-looking inbound can't force a cheaper,
 * lower-quality draft. Ambiguous / important / low-confidence messages keep the
 * capable tier, and when routing is off this is exactly today's single-tier
 * behaviour.
 */
export async function resolveLanguageModelForClassifiedDraft(
	ctx: ActionCtx,
	signals: ClassificationSignals
): Promise<LanguageModel> {
	const language = await resolveLanguagePlane(ctx);
	const downgrade =
		getOptional('LLM_COMPLEXITY_ROUTING') === '1' && isTrivialClassifiedMessage(signals);
	return resolveLanguageModelFromPlane(language, downgrade ? 'fast' : 'capable').model;
}

// Known embedding models and their native output width. Used to fail fast when
// a configured model's vectors are WIDER than the fixed EMBEDDING_DIMENSIONS
// index (narrower ones are zero-padded by toIndexVector). Unknown/custom models
// aren't listed — an oversized vector is caught at embed time by toIndexVector.
const KNOWN_EMBEDDING_DIMENSIONS: Record<string, number> = {
	'text-embedding-3-small': 1536,
	'text-embedding-ada-002': 1536,
	'text-embedding-3-large': 3072,
};

/**
 * Fail fast when a resolved embedding model's known native width is wider than
 * the fixed vector index. Only checks models with a known width; local/custom
 * ones are checked at embed time by {@link toIndexVector}.
 */
function assertKnownEmbeddingWidth(modelId: string): void {
	const known = KNOWN_EMBEDDING_DIMENSIONS[modelId];
	if (known !== undefined && known > EMBEDDING_DIMENSIONS) {
		throw new Error(
			`Embedding model '${modelId}' produces ${known}-dimensional vectors, but the ` +
				`vector index is fixed at ${EMBEDDING_DIMENSIONS}. Choose a ${EMBEDDING_DIMENSIONS}-dim ` +
				`embedding model (e.g. text-embedding-3-small) or change the schema vectorIndex dimensions.`
		);
	}
}

/**
 * Resolve the embedding model used by knowledge graph / semantic file search /
 * quickQuery, through the SAME {@link resolveAiConfig} point as the language
 * plane but INDEPENDENTLY of the language provider. A misconfigured hosted
 * embedder (e.g. no key) throws an actionable error HERE — before any `embed()`
 * call — so it can never degrade to a silent empty/zero vector. Callers that
 * fail soft on transient embed failures must resolve the model OUTSIDE their
 * try/catch so a misconfiguration surfaces rather than being swallowed.
 */
export async function resolveEmbeddingModel(ctx: ActionCtx): Promise<EmbeddingModel> {
	const { kind, modelId, clientConfig } = await resolveEmbeddingPlaneConfig(ctx);
	assertKnownEmbeddingWidth(modelId);
	const adapter = embeddingProviderFor(kind);
	// Surface an unusable config (missing hosted key / local base URL) as an
	// actionable error before building the model.
	adapter.validateCredentials({ ...clientConfig, modelId });
	return adapter.buildEmbeddingModel({ ...clientConfig, modelId });
}

/**
 * Fit an embedding vector to the fixed-width vector index.
 *
 * The index is EMBEDDING_DIMENSIONS wide (the OpenAI default), but the DEFAULT
 * embedder is local (`nomic-embed-text`, 768-dim) and Google / most
 * OpenAI-compatible models are narrower too. A narrower vector is right-padded
 * with zeros: padding changes neither dot products nor norms, so cosine
 * similarity between two padded vectors is exactly that of the originals, and
 * the index ranks them identically. Rejecting them instead meant the default
 * configuration could never store a single knowledge entry.
 *
 * A WIDER vector can't be fitted without changing its geometry, so it throws —
 * an actionable error rather than a silently-broken vector search. Query-time
 * vectors go through here too: a 768-dim query against 1536-wide rows would be
 * refused by the index.
 */
export function toIndexVector(embedding: ArrayLike<number>): number[] {
	if (embedding.length > EMBEDDING_DIMENSIONS) {
		throw new Error(
			`Embedding model produced a ${embedding.length}-dimensional vector but the vector ` +
				`index holds at most ${EMBEDDING_DIMENSIONS}. Choose an embedding model of at most ` +
				`${EMBEDDING_DIMENSIONS} dimensions.`
		);
	}
	if (embedding.length === 0) {
		throw new Error('Embedding model returned an empty vector.');
	}
	const vector = Array.from(embedding);
	while (vector.length < EMBEDDING_DIMENSIONS) vector.push(0);
	return vector;
}

/** Snapshot of the active env LLM configuration for logging / debugging (no secrets). */
export function getLLMConfig() {
	return {
		provider: getOptional('LLM_PROVIDER') ?? 'openai',
		modelFast: modelIdForTier('fast'),
		modelCapable: modelIdForTier('capable'),
		embeddingModel: getOptional('LLM_EMBEDDING_MODEL') ?? DEFAULT_EMBEDDING_MODEL,
		baseURL: resolveBaseURL(),
		hasApiKey: !!envLlmApiKey(),
	};
}
