/**
 * Which embedding target the deployment's configuration names (AI routing plan,
 * Phase 1a provenance and owner decision D8).
 *
 * A target is the configured part of an embedding space: provider kind, the
 * secret-free endpoint identity, the resolved model and the width requested
 * from the provider. The measured part (native width, and for local models the
 * artifact digest and quantization) is added after an embedding call
 * (`lib/aiRouting/embeddingProbe.ts`), and the complete identity is an
 * `embeddingSpaces` row (`lib/aiRouting/embeddingRegistry.ts`).
 *
 * Since provenance exists, a populated deployment may switch targets: every
 * vector records its space, retrieval searches only the active one, and the
 * re-embed job brings the rest back (D8, post-provenance). Everything here is
 * pure or reads env, so the v8 settings mutation, the commit mutations and the
 * resolver (`lib/llmProvider.ts`) share one definition.
 */

import {
	GOOGLE_EMBEDDING_DEFAULT,
	LEGACY_GOOGLE_EMBEDDING_MODEL,
} from '@owlat/shared/aiModelCatalog';
import { throwInvalidInput } from '../_utils/errors';
import { isEnvAiProviderConfigured } from './aiNotConfigured';
import { CURRENT_EMBEDDING_MODEL } from './constants';
import { getOptional } from './env';
import { type EmbeddingProviderKind } from './llmProviders/types';

/** Each embedding adapter's default model. The adapters read theirs from here. */
export const EMBEDDING_DEFAULT_MODELS = {
	local: 'nomic-embed-text',
	openai: CURRENT_EMBEDDING_MODEL,
	google: GOOGLE_EMBEDDING_DEFAULT.model,
	openaiCompatible: 'nomic-embed-text',
} as const satisfies Record<EmbeddingProviderKind, string>;

/** Kinds served from the deployment's own embedder (`LOCAL_EMBEDDING_*`). */
export function isLocalEmbeddingKind(kind: EmbeddingProviderKind): boolean {
	return kind === 'local' || kind === 'openaiCompatible';
}

/** The vector width an adapter requests, or `native` when it takes the model's own. */
export function requestedEmbeddingDimensions(
	kind: EmbeddingProviderKind,
	modelId: string
): number | 'native' {
	return kind === 'google' && modelId === GOOGLE_EMBEDDING_DEFAULT.model
		? GOOGLE_EMBEDDING_DEFAULT.dimensions
		: 'native';
}

/** An embedding selection as the `aiProviderConfig` row stores it. */
export interface StoredEmbeddingSelection {
	readonly embeddingProviderKind: EmbeddingProviderKind;
	readonly embeddingModel?: string;
}

/**
 * The model a stored selection resolves to. An explicit model wins. A Google row
 * without one predates the `gemini-embedding-2` default and keeps the model it
 * was written with; a local kind follows `LOCAL_EMBEDDING_MODEL`.
 */
export function resolveStoredEmbeddingModel(selection: StoredEmbeddingSelection): string {
	const kind = selection.embeddingProviderKind;
	if (selection.embeddingModel) return selection.embeddingModel;
	if (kind === 'google') return LEGACY_GOOGLE_EMBEDDING_MODEL;
	if (isLocalEmbeddingKind(kind)) {
		return getOptional('LOCAL_EMBEDDING_MODEL') ?? EMBEDDING_DEFAULT_MODELS[kind];
	}
	return EMBEDDING_DEFAULT_MODELS[kind];
}

/** The env fallback's embedding model (no stored row). */
export function envEmbeddingModel(): string {
	return getOptional('LLM_EMBEDDING_MODEL') ?? EMBEDDING_DEFAULT_MODELS.openai;
}

/** Each local adapter's default base URL. The adapters read theirs from here. */
export const LOCAL_EMBEDDING_DEFAULT_BASE_URLS = {
	// The `ollama` service of the self-host compose file; `localhost` is the
	// Convex container itself, where nothing listens.
	local: 'http://ollama:11434/v1',
	openaiCompatible: 'http://localhost:11434/v1',
} as const;

/** The env plane's base URL: the explicit override, else the provider's default. */
export function envLlmBaseUrl(): string | undefined {
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

/** The base URL a local embedding kind reaches (`LOCAL_EMBEDDING_BASE_URL`, else the default). */
export function localEmbeddingBaseUrl(kind: 'local' | 'openaiCompatible'): string {
	return getOptional('LOCAL_EMBEDDING_BASE_URL') ?? LOCAL_EMBEDDING_DEFAULT_BASE_URLS[kind];
}

/**
 * The secret-free identity of an endpoint: its origin (scheme, host, port).
 * Never a path, query or userinfo, which may carry a credential.
 */
export function endpointIdentity(url: string): string {
	try {
		return new URL(url).origin.toLowerCase();
	} catch {
		return 'invalid';
	}
}

/** Where a target was resolved from. */
export type EmbeddingTargetSource = 'stored_config' | 'env';

/** The configured part of an embedding space. */
export interface EmbeddingTarget {
	readonly provider: EmbeddingProviderKind;
	/** `native`, or the origin of the base URL the embedder calls. */
	readonly endpoint: string;
	readonly model: string;
	readonly requestedDimensions: number | 'native';
	readonly source: EmbeddingTargetSource;
	/** Served by the deployment itself, so re-embedding costs nothing. */
	readonly isLocal: boolean;
	/** The base URL whose server may report an artifact revision (Ollama). */
	readonly probeBaseUrl?: string;
}

export function storedEmbeddingTarget(selection: StoredEmbeddingSelection): EmbeddingTarget {
	const kind = selection.embeddingProviderKind;
	const model = resolveStoredEmbeddingModel(selection);
	const base = {
		provider: kind,
		model,
		requestedDimensions: requestedEmbeddingDimensions(kind, model),
		source: 'stored_config' as const,
	};
	if (kind === 'local' || kind === 'openaiCompatible') {
		const baseUrl = localEmbeddingBaseUrl(kind);
		return { ...base, endpoint: endpointIdentity(baseUrl), isLocal: true, probeBaseUrl: baseUrl };
	}
	return { ...base, endpoint: 'native', isLocal: false };
}

/**
 * The env fallback's target, or null when the environment configures no AI.
 * The env plane always uses the OpenAI adapter; its endpoint tells the native
 * API, OpenRouter, Ollama and a custom server apart. Only env Ollama is local
 * (and probed): a custom base URL may be a paid service.
 */
export function envEmbeddingTarget(): EmbeddingTarget | null {
	if (!isEnvAiProviderConfigured()) return null;
	const baseUrl = envLlmBaseUrl();
	const isOllama = getOptional('LLM_PROVIDER') === 'ollama';
	return {
		provider: 'openai',
		endpoint: baseUrl ? endpointIdentity(baseUrl) : 'native',
		model: envEmbeddingModel(),
		requestedDimensions: 'native',
		source: 'env',
		isLocal: isOllama,
		...(isOllama && baseUrl ? { probeBaseUrl: baseUrl } : {}),
	};
}

/** The target vectors are written in today: the stored row's, else the env fallback's. */
export function configuredEmbeddingTarget(
	row: StoredEmbeddingSelection | null
): EmbeddingTarget | null {
	return row ? storedEmbeddingTarget(row) : envEmbeddingTarget();
}

export function isSameEmbeddingTarget(a: EmbeddingTarget, b: EmbeddingTarget): boolean {
	return (
		a.provider === b.provider &&
		a.endpoint === b.endpoint &&
		a.model === b.model &&
		a.requestedDimensions === b.requestedDimensions
	);
}

/**
 * The embedding selection a settings save persists. Whatever the save omits
 * keeps the stored selection, so an API or CLI save that names only the language
 * plane never moves the vector space. A newly chosen Google embedder stores its
 * default explicitly, because an absent model on a Google row means the legacy one.
 */
export function embeddingSelectionForSave(
	requested: { kind?: EmbeddingProviderKind; model?: string },
	stored: StoredEmbeddingSelection | null
): { embeddingProviderKind: EmbeddingProviderKind; embeddingModel: string | undefined } {
	const kind = requested.kind ?? stored?.embeddingProviderKind ?? 'local';
	const model = requested.model?.trim() || undefined;
	if (model || stored?.embeddingProviderKind !== kind) {
		const fallback = kind === 'google' ? EMBEDDING_DEFAULT_MODELS.google : undefined;
		return { embeddingProviderKind: kind, embeddingModel: model ?? fallback };
	}
	return { embeddingProviderKind: kind, embeddingModel: stored.embeddingModel };
}

/** A new embedding key needs the kind it belongs to; never the row's, which may change. */
export function throwEmbeddingKindRequired(): never {
	throwInvalidInput('Choose the embedding provider this API key belongs to.', {
		reason: 'embedding_kind_required',
	});
}

/**
 * The `embeddingModelVersion` a settings save writes. It moves only when the
 * configured target does, so resubmitting the model an absent field already
 * resolved to is a no-op. Since provenance exists the save is never refused: a
 * switch drops the old space out of vector search until the re-embed job or a
 * staged rebuild replaces its vectors (D8, post-provenance).
 */
export function nextEmbeddingModelVersion(
	existing: (StoredEmbeddingSelection & { readonly embeddingModelVersion: number }) | null,
	selection: StoredEmbeddingSelection
): number {
	if (!existing) return 1;
	const isSame = isSameEmbeddingTarget(
		storedEmbeddingTarget(existing),
		storedEmbeddingTarget(selection)
	);
	return existing.embeddingModelVersion + (isSame ? 0 : 1);
}
