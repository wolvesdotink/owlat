/**
 * LLM provider resolution for the agent pipeline.
 *
 * The ONE resolution point for the LANGUAGE plane (per the 2026-07-10 pluggable
 * AI-providers plan). `resolveAiConfig(ctx)` produces a typed
 * {@link ResolvedProviderConfig} for both planes from a dual source:
 *
 *   • STORED per-org config (`aiProviderConfig` row) WINS when present. The
 *     language key is decrypted ONLY for hosted providers, and ONLY inside the
 *     sibling `'use node'` action `aiProviderConfigActions._decryptLanguageKey`
 *     (the plaintext key never crosses to a query result or the client).
 *   • ENV `LLM_*` is the deployment fallback when no row exists — self-hosters
 *     who set `LLM_*` keep working with zero UI.
 *
 * The resolved config is memoized in-process for a short TTL so a burst of LLM
 * calls reads (and decrypts) at most once per window rather than per call. Both
 * paths resolve THROUGH the provider-adapter registry (`./llmProviders`): a
 * `kind` selects the adapter and the adapter builds the client — so adding a
 * provider is one adapter file and this module stays dumb about provider
 * specifics.
 *
 * `resolveLanguageModel(ctx, task)` (async) replaces the former sync, env-only
 * per-task resolver. Embedding resolution still runs through the env-only
 * `getEmbeddingModel()` for now (the embedding-plane upgrade is a later plan
 * piece); the embedding selection is surfaced on the resolved config so that
 * piece can consume it.
 *
 * Environment (fallback only):
 *   LLM_PROVIDER        openai (default) | openrouter | ollama
 *   LLM_API_KEY | OPENROUTER_API_KEY | OPENAI_API_KEY  — first one set wins
 *   LLM_BASE_URL        explicit base-URL override (e.g. an OpenAI-compat proxy)
 *   LLM_MODEL_FAST / LLM_MODEL_CAPABLE / LLM_MODEL      model IDs per tier
 *   LLM_EMBEDDING_MODEL embedding model (default text-embedding-3-small)
 */

import type { LanguageModel } from 'ai';
import { internal } from '../_generated/api';
import type { ActionCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
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
	type LanguageProviderKind,
	type ProviderClientConfig,
} from './llmProviders';
import type { StoredEmbeddingProviderKind } from './aiProviderConfigValidators';

/**
 * Task types map to a model tier:
 * - fast: classification, extraction, guardrails, summarization
 * - capable: drafting replies, planning multi-step actions
 */
export type LLMTask = 'classify' | 'extract' | 'guard' | 'summarize' | 'draft' | 'plan';
/** Model tiers exposed to callers. */
export type LLMTier = 'fast' | 'capable';

/** The resolved language plane — kind + secret-bearing client + per-tier models. */
export interface ResolvedLanguagePlane {
	readonly kind: LanguageProviderKind;
	/** Decrypted client config (apiKey present only for hosted providers). */
	readonly clientConfig: ProviderClientConfig;
	readonly models: { readonly fast: string; readonly capable: string };
}

/**
 * The resolved embedding plane — resolved INDEPENDENTLY of the language plane.
 * The embedding-plane upgrade (a later plan piece) consumes this; today
 * {@link getEmbeddingModel} still resolves embeddings from env directly.
 */
export interface ResolvedEmbeddingPlane {
	readonly kind: StoredEmbeddingProviderKind;
	readonly modelId: string;
}

/** The dual-source-resolved AI config for both planes. */
export interface ResolvedProviderConfig {
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

/** Resolve both planes from the env `LLM_*` fallback (no stored row present). */
export function resolveEnvProviderConfig(): ResolvedProviderConfig {
	return {
		source: 'env',
		language: {
			kind: ENV_LANGUAGE_KIND,
			clientConfig: resolveEnvClientConfig(),
			models: { fast: modelIdForTier('fast'), capable: modelIdForTier('capable') },
		},
		embedding: {
			kind: ENV_EMBEDDING_KIND,
			modelId: getOptional('LLM_EMBEDDING_MODEL') ?? DEFAULT_EMBEDDING_MODEL,
		},
	};
}

/**
 * Map a stored config row into a resolved config. `languageKey` is the decrypted
 * language-provider key (already fetched via the Node decrypt action for hosted
 * providers, `undefined` for local/keyless ones).
 */
export function buildStoredProviderConfig(
	row: Doc<'aiProviderConfig'>,
	languageKey: string | undefined
): ResolvedProviderConfig {
	const adapter = languageProviderFor(row.languageProviderKind);
	return {
		source: 'stored',
		updatedAt: row.updatedAt,
		language: {
			kind: row.languageProviderKind,
			clientConfig: { apiKey: languageKey, baseUrl: row.languageBaseUrl ?? adapter.defaultBaseUrl },
			models: { fast: row.modelFast, capable: row.modelCapable },
		},
		embedding: {
			kind: row.embeddingProviderKind,
			modelId: row.embeddingModel ?? DEFAULT_EMBEDDING_MODEL,
		},
	};
}

// A short in-process TTL cache so a burst of LLM calls (classify → clarify →
// draft → guard …) resolves — and decrypts — the config at most once per window
// rather than per call. Bounded staleness after an admin edit is the tradeoff.
const AI_CONFIG_CACHE_TTL_MS = 30_000;
let configCache: { config: ResolvedProviderConfig; expiresAt: number } | null = null;

/** True when a stored row carries a complete language-key envelope to decrypt. */
function hasLanguageKeyEnvelope(row: Doc<'aiProviderConfig'>): row is Doc<'aiProviderConfig'> & {
	secretCiphertext: string;
	secretIv: string;
	secretAuthTag: string;
	secretEnvelopeVersion: number;
} {
	return (
		row.secretCiphertext !== undefined &&
		row.secretIv !== undefined &&
		row.secretAuthTag !== undefined &&
		row.secretEnvelopeVersion !== undefined
	);
}

/**
 * Resolve the org's AI config for both planes: the stored per-org row WINS when
 * present (decrypting the hosted language key inside a Node action), otherwise
 * the env `LLM_*` fallback. Memoized for a short TTL. This is the single point
 * every language-model resolution flows through.
 */
export async function resolveAiConfig(ctx: ActionCtx): Promise<ResolvedProviderConfig> {
	const cached = configCache;
	if (cached && cached.expiresAt > Date.now()) return cached.config;

	const row = await ctx.runQuery(internal.aiProviderConfig._getConfigRow, {});
	let config: ResolvedProviderConfig;
	if (!row) {
		config = resolveEnvProviderConfig();
	} else {
		const adapter = languageProviderFor(row.languageProviderKind);
		let languageKey: string | undefined;
		if (!adapter.isLocal && hasLanguageKeyEnvelope(row)) {
			// Decrypt ONLY inside the Node action — this v8-safe module never
			// touches node:crypto. The plaintext key builds the model and is then
			// discarded; it never reaches a query result or the client.
			languageKey = await ctx.runAction(internal.aiProviderConfigActions._decryptLanguageKey, {
				ciphertext: row.secretCiphertext,
				iv: row.secretIv,
				authTag: row.secretAuthTag,
				version: row.secretEnvelopeVersion,
			});
		}
		config = buildStoredProviderConfig(row, languageKey);
	}

	configCache = { config, expiresAt: Date.now() + AI_CONFIG_CACHE_TTL_MS };
	return config;
}

/** Test-only: drop the in-process config cache so a fresh resolution runs. */
export function __resetAiConfigCacheForTests(): void {
	configCache = null;
}

/** Build the AI-SDK language model for a resolved config + tier via the registry. */
function buildLanguageModelFromConfig(cfg: ResolvedProviderConfig, tier: LLMTier): LanguageModel {
	const modelId = tier === 'fast' ? cfg.language.models.fast : cfg.language.models.capable;
	return languageProviderFor(cfg.language.kind).buildChatModel(cfg.language.clientConfig, modelId);
}

/** Resolve the language model for a given task (plugs into the AI SDK helpers). */
export async function resolveLanguageModel(
	ctx: ActionCtx,
	task: LLMTask = 'draft'
): Promise<LanguageModel> {
	const cfg = await resolveAiConfig(ctx);
	return buildLanguageModelFromConfig(cfg, taskTier(task));
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
	const cfg = await resolveAiConfig(ctx);
	const downgrade =
		getOptional('LLM_COMPLEXITY_ROUTING') === '1' &&
		taskTier(task) === 'capable' &&
		isTrivialUserText(userText);
	return buildLanguageModelFromConfig(cfg, downgrade ? 'fast' : taskTier(task));
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
	const cfg = await resolveAiConfig(ctx);
	const downgrade =
		getOptional('LLM_COMPLEXITY_ROUTING') === '1' && isTrivialClassifiedMessage(signals);
	return buildLanguageModelFromConfig(cfg, downgrade ? 'fast' : 'capable');
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

/** Snapshot of the active env LLM configuration for logging / debugging (no secrets). */
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
