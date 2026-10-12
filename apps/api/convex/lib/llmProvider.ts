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
 * The row is memoized in-process (`./llmProviders/storedConfigCache`), re-read
 * every 30 s (or at once, `isFresh`); each plane's key is decrypted only when
 * that plane is asked for, kept five minutes, and dropped when the row changes.
 * A `kind` selects the adapter (`./llmProviders`) that builds the client.
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
 * A misconfigured hosted embedder throws an actionable error at resolve time (never
 * a silent zero vector); `toIndexVector` fits every vector to the index width.
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
import type { AiTaskName } from '@owlat/shared/aiRouting';
import {
	classifiedDraftRoute,
	type ClassificationSignals,
	type ClassifiedDraftRoute,
	type ClassifiedDraftRouteOptions,
} from './llm/complexity';
import { taskTier, userTextTier, type LlmTier, type TierChoice } from './llm/taskRouting';
import { stampModelEndpoint } from './llm/modelEndpoint';
import { isLocalEndpoint } from './llm/endpointLocality';
import { EMBEDDING_DIMENSIONS } from './constants';
import {
	configuredEmbeddingTarget,
	envEmbeddingModel,
	envLlmBaseUrl,
	localEmbeddingBaseUrl,
	resolveStoredEmbeddingModel,
	type EmbeddingTarget,
} from './embeddingSpace';
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
import { languageModelIdentity } from './llm/languageIdentity';
import { configVersionOf } from './decision/configIdentity';
import type { StoredEmbeddingProviderKind } from './validators/aiProviderConfig';
import {
	invalidateAiConfigCache,
	loadConfigEntry,
	planeKey,
} from './llmProviders/storedConfigCache';

export { invalidateAiConfigCache } from './llmProviders/storedConfigCache';
type Fresh = { isFresh?: boolean };

/** The resolved language plane — kind + secret-bearing client + per-tier models. */
interface ResolvedLanguagePlane {
	readonly kind: LanguageProviderKind;
	readonly endpointProvenance: LanguageEndpointProvenance;
	/** Decrypted client config (apiKey present only for hosted providers). */
	readonly clientConfig: ProviderClientConfig;
	readonly models: { readonly fast: string; readonly capable: string };
	/** The stored row's version (`configVersionOf`); absent under the env fallback. */
	readonly configVersion?: string;
}

/**
 * The resolved embedding plane — resolved INDEPENDENTLY of the language plane
 * ({@link resolveEmbeddingModel} builds the AI-SDK model from it). `clientConfig`
 * carries the local sidecar base URL or the decrypted hosted-embedder key;
 * `modelVersion` is the stored dimension-guard version (absent for env fallback).
 */
export interface ResolvedEmbeddingPlane {
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
}

// Environment setup must select the same adapter/defaults as stored settings.
// OpenRouter and local servers speak chat completions, while native GPT-6 uses
// Responses (including tool calls). A base URL alone cannot choose that wire.
function envLanguageKind(): LanguageProviderKind {
	switch (getOptional('LLM_PROVIDER')) {
		case 'openrouter':
			return 'openrouter';
		case 'ollama':
		case 'custom':
			return 'openaiCompatible';
		default:
			return 'openai';
	}
}
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
	return { apiKey: apiKey ?? 'ollama', baseUrl: envLlmBaseUrl() };
}

function modelIdForTier(tier: LlmTier): string {
	const defaults = languageProviderFor(envLanguageKind()).defaultModels;
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
export function resolveEmbeddingPlane(
	kind: StoredEmbeddingProviderKind,
	storedModel: string | undefined,
	hostedKey: string | undefined,
	modelVersion: number | undefined
): ResolvedEmbeddingPlane {
	const adapter = embeddingProviderFor(kind);
	const clientConfig: ProviderClientConfig = adapter.isLocal
		? // The canonical base URL its identity names (lib/embeddingSpace.ts).
			{ baseUrl: localEmbeddingBaseUrl(kind as 'local' | 'openaiCompatible') }
		: { apiKey: hostedKey };
	const modelId = resolveStoredEmbeddingModel({
		embeddingProviderKind: kind,
		embeddingModel: storedModel,
	});
	return { kind, modelId, clientConfig, modelVersion };
}

/** Resolve both planes from the env `LLM_*` fallback (no stored row present). */
function resolveEnvProviderConfig(): ResolvedProviderConfig {
	// The language and embedding planes share the env key/base-URL here (the
	// prior single-client behavior); resolve it once.
	const clientConfig = resolveEnvClientConfig();
	return {
		source: 'env',
		language: {
			kind: envLanguageKind(),
			endpointProvenance: classifyEnvLanguageEndpoint(
				getOptional('LLM_PROVIDER'),
				Boolean(getOptional('LLM_BASE_URL'))
			),
			clientConfig,
			models: { fast: modelIdForTier('fast'), capable: modelIdForTier('capable') },
		},
		embedding: {
			kind: ENV_EMBEDDING_KIND,
			modelId: envEmbeddingModel(),
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
		language: {
			configVersion: configVersionOf(row),
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
async function resolveLanguagePlane(ctx: ActionCtx, options: Fresh = {}) {
	const entry = await loadConfigEntry(ctx, options);
	if (!entry.row) return resolveEnvProviderConfig().language;
	const languageKey = await planeKey(ctx, entry, 'language');
	return buildStoredProviderConfig(entry.row, languageKey, undefined).language;
}

/**
 * One read of the current configuration (never the language key): its
 * embedding target now, and its plane, credential included, built from that
 * same read only when asked. What a caller checks is what it embeds with.
 */
export async function readEmbeddingConfigSnapshot(
	ctx: ActionCtx
): Promise<{ target: EmbeddingTarget | null; plane: () => Promise<ResolvedEmbeddingPlane> }> {
	const entry = await loadConfigEntry(ctx, { isFresh: true });
	const plane = async () =>
		entry.row
			? buildStoredProviderConfig(entry.row, undefined, await planeKey(ctx, entry, 'embedding'))
					.embedding
			: resolveEnvProviderConfig().embedding;
	return { target: configuredEmbeddingTarget(entry.row), plane };
}

/** Test-only: drop the in-process config cache so a fresh resolution runs. */
export const __resetAiConfigCacheForTests = invalidateAiConfigCache;

/** Build a model together with the trusted, secret-free resolution metadata. */
function resolveLanguageModelFromPlane(
	language: ResolvedLanguagePlane,
	tier: LlmTier
): ResolvedLanguageModel {
	const modelId = tier === 'fast' ? language.models.fast : language.models.capable;
	const adapter = languageProviderFor(language.kind);
	return Object.freeze({
		// Stamped with its endpoint (ledger rows; a model on our network costs nothing)
		// and its tier (the dispatch refuses it for a task not allowed it). ADR-0073.
		model: stampModelEndpoint(
			adapter.buildChatModel(language.clientConfig, modelId),
			language.endpointProvenance,
			{ isLocal: isLocalEndpoint(language.kind, language.clientConfig.baseUrl, adapter), tier }
		),
		modelId,
		endpointProvenance: language.endpointProvenance,
		identity: languageModelIdentity(language.kind, modelId, language.clientConfig.baseUrl),
		...(language.configVersion ? { configVersion: language.configVersion } : {}),
	});
}

/**
 * Resolve the language model for one call of `task`, with its endpoint
 * identity (hard-budget consumers price it). The tier is the task's
 * (`./llm/taskRouting.ts`, from the task-policy catalog): its usual tier, or
 * the one `choice` names when allowed. `isFresh` re-reads the row (a bundle's claim).
 */
export async function resolveLanguageModelWithProvenance(
	ctx: ActionCtx,
	task: AiTaskName,
	choice?: TierChoice,
	options: Fresh = {}
): Promise<ResolvedLanguageModel> {
	const tier = taskTier(task, choice);
	return resolveLanguageModelFromPlane(await resolveLanguagePlane(ctx, options), tier);
}

/** Resolve the language model for one call of `task` (plugs into the AI SDK helpers). */
export async function resolveLanguageModel(
	ctx: ActionCtx,
	task: AiTaskName,
	choice?: TierChoice
): Promise<LanguageModel> {
	return (await resolveLanguageModelWithProvenance(ctx, task, choice)).model;
}

/** `LLM_COMPLEXITY_ROUTING=1` (default off): downgrade clearly trivial work to the fast tier. */
function isComplexityRoutingOn(): boolean {
	return getOptional('LLM_COMPLEXITY_ROUTING') === '1';
}

/**
 * Resolve a model for a *user-facing* task, optionally downgrading its capable
 * tier to fast when the user's input is clearly trivial and complexity routing
 * is enabled (`LLM_COMPLEXITY_ROUTING=1`, default off). Only a capable-tier
 * task whose catalog entry allows `fast` downgrades, and only obviously-trivial
 * input does — ambiguous text keeps the capable model so quality never
 * silently drops. `userText` must be the user-controlled text ONLY (never the
 * system prompt / assembled context).
 */
export async function resolveLanguageModelForUserText(
	ctx: ActionCtx,
	task: AiTaskName,
	userText: string
): Promise<LanguageModel> {
	const tier = userTextTier(task, userText, isComplexityRoutingOn());
	return resolveLanguageModelFromPlane(await resolveLanguagePlane(ctx), tier).model;
}

/**
 * How the inbound agent's `draft` step writes its reply (`./llm/complexity.ts`
 * `classifiedDraftRoute`), from the TRUSTED, sanitized classifier signals only
 * (never the attacker-controlled email body, so a crafted "thanks!" cannot
 * force a cheaper draft): `fast` under `LLM_COMPLEXITY_ROUTING=1` for a
 * clearly trivial message, as before; `cheap_first` for an eligible REVIEWED
 * draft with the policy's `cheapFirstWriter` on (D2); else `capable`. With
 * both off (the defaults) this is exactly today's single-tier behaviour.
 */
export function classifiedDraftRouteOf(
	signals: ClassificationSignals,
	writer: Omit<ClassifiedDraftRouteOptions, 'isComplexityRoutingOn'> = {
		cheapFirstWriter: 'off',
		isReviewedDraft: false,
	}
): ClassifiedDraftRoute {
	return classifiedDraftRoute(signals, {
		...writer,
		isComplexityRoutingOn: isComplexityRoutingOn(),
	});
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
	return (await resolveIndexEmbedder(ctx)).model;
}

/**
 * An embedding model with the target it embeds in. A caller that stores or
 * searches a vector completes the target into the vector's space identity with
 * `measuredEmbeddingSpace` (`lib/aiRouting/embeddingProbe.ts`), after the call.
 */
export interface IndexEmbedder {
	readonly model: EmbeddingModel;
	readonly target: EmbeddingTarget;
}

/** Build an embedder for a resolved plane. Throws an actionable error on an unusable config. */
export function buildIndexEmbedder(
	plane: Pick<ResolvedEmbeddingPlane, 'kind' | 'modelId' | 'clientConfig'>,
	target: EmbeddingTarget
): IndexEmbedder {
	const { kind, modelId, clientConfig } = plane;
	assertKnownEmbeddingWidth(modelId);
	const adapter = embeddingProviderFor(kind);
	// Surface an unusable config (missing hosted key / local base URL) as an
	// actionable error before building the model.
	adapter.validateCredentials({ ...clientConfig, modelId });
	return {
		// Stamped so the embedding's ledger row names its endpoint, and a
		// self-hosted embedder's rows cost nothing (ADR-0073).
		model: stampModelEndpoint(
			adapter.buildEmbeddingModel({ ...clientConfig, modelId }),
			`embedding:${kind}`,
			{ isLocal: isLocalEndpoint(kind, clientConfig.baseUrl, adapter) }
		),
		target,
	};
}

/** The configured embedder and its target (stored row, else the env fallback). */
export async function resolveIndexEmbedder(ctx: ActionCtx): Promise<IndexEmbedder> {
	const { plane, target } = await readEmbeddingConfigSnapshot(ctx);
	// No target: neither a stored row nor an env configuration.
	if (!target) throw new AiNotConfiguredError();
	return buildIndexEmbedder(await plane(), target);
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
		embeddingModel: envEmbeddingModel(),
		baseURL: envLlmBaseUrl(),
		hasApiKey: !!envLlmApiKey(),
	};
}
