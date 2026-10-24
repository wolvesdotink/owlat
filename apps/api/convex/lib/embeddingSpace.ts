/**
 * Which embedding target the deployment's configuration names (embedding
 * provenance).
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
 * re-embed job brings the rest back (post-provenance). Everything here is
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
import { resolveEndpointLocality, type EndpointLocality } from './llm/endpointLocality';
import { sha256Hex } from './aiRouting/routeDigest';

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
	if (explicit) return canonicalBaseUrl(explicit);
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
	return canonicalBaseUrl(
		getOptional('LOCAL_EMBEDDING_BASE_URL') ?? LOCAL_EMBEDDING_DEFAULT_BASE_URLS[kind]
	);
}

/**
 * THE canonical form of an endpoint base URL, used both to dispatch (the SDK
 * client is built with it) and to name the endpoint (`endpointIdentity`), so
 * the identity always describes exactly where requests go: repeated slashes in
 * the path collapse, a trailing slash goes, the fragment (never sent) goes;
 * scheme, userinfo, host, port, path and query are kept as sent. An unparsable
 * URL is returned unchanged (the call fails, and its identity is `invalid`).
 */
export function canonicalBaseUrl(url: string): string {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return url;
	}
	const path = parsed.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
	const userinfo = parsed.username
		? `${parsed.username}${parsed.password ? `:${parsed.password}` : ''}@`
		: '';
	return `${parsed.protocol}//${userinfo}${parsed.host}${path}${parsed.search}`;
}

/**
 * The secret-free identity of an endpoint: its origin (scheme, host, port) and,
 * when requests carry more, a digest of the rest of its canonical base URL
 * (`canonicalBaseUrl`: userinfo, path, query). Two services on one origin under
 * different paths (`/a/v1`, `/b/v1`) are different endpoints; any of those
 * parts may carry a credential, so only a SHA-256 prefix of them is kept. The
 * same canonical URL is what the client dispatches to.
 */
export function endpointIdentity(url: string): string {
	let parsed: URL;
	try {
		parsed = new URL(canonicalBaseUrl(url));
	} catch {
		return 'invalid';
	}
	const origin = parsed.origin.toLowerCase();
	// Everything after the origin that requests carry: userinfo, path, query.
	const userinfo = parsed.username ? `${parsed.username}:${parsed.password}@` : '';
	const route = `${userinfo}${parsed.pathname === '/' ? '' : parsed.pathname}${parsed.search}`;
	return route === '' ? origin : `${origin}/~${sha256Hex(route).slice(0, 32)}`;
}

/** Any `scheme://…` URL in free text, up to whitespace or a quote. */
const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>`]+/gi;

/**
 * Error text that may leave the embedding code (a log line, a job's stored
 * `lastError`), with every URL in it replaced by its {@link endpointIdentity}.
 * A base URL may carry credentials in its userinfo, path or query, and fetch
 * and SDK errors quote the request URL ("Cannot connect to API: …", "Failed to
 * parse URL from …"); the identity keeps the origin and hashes the rest.
 */
export function secretFreeErrorText(error: unknown): string {
	return String(error).replace(URL_IN_TEXT, (url) => endpointIdentity(url));
}

/**
 * Whether an embedding endpoint is local (free) or hosted (paid), by the
 * ledger's one rule (`lib/llm/endpointLocality.ts`): the `local` kind, or an
 * OpenAI-compatible endpoint on a loopback, private or single-label host. Every
 * other endpoint, an unparsable one included, is hosted.
 */
export function embeddingEndpointLocality(
	kind: EmbeddingProviderKind,
	baseUrl: string | undefined
): EndpointLocality {
	return resolveEndpointLocality(kind, baseUrl);
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
	/**
	 * Local by the ledger's rule (`embeddingEndpointLocality`), so re-embedding
	 * costs nothing. Decided again from the resolved embedder before each dispatch.
	 */
	readonly isLocal: boolean;
	/**
	 * Set exactly when `isLocal`: the base URL whose server is asked for the
	 * model's artifact revision (Ollama's tags API; any other server leaves the
	 * revision unknown). A hosted endpoint is never probed.
	 */
	readonly probeBaseUrl?: string;
}

/**
 * A target's endpoint fields from ONE locality decision (the ledger's rule):
 * a local endpoint is both free and probed for its revision, whatever the
 * kind or `LLM_PROVIDER`, so payment and revision tracking cannot drift apart.
 */
function endpointFields(
	kind: EmbeddingProviderKind,
	baseUrl: string | undefined
): Pick<EmbeddingTarget, 'endpoint' | 'isLocal' | 'probeBaseUrl'> {
	const isLocal = embeddingEndpointLocality(kind, baseUrl) === 'local';
	return {
		endpoint: baseUrl ? endpointIdentity(baseUrl) : 'native',
		isLocal,
		...(isLocal && baseUrl ? { probeBaseUrl: baseUrl } : {}),
	};
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
	const baseUrl =
		kind === 'local' || kind === 'openaiCompatible' ? localEmbeddingBaseUrl(kind) : undefined;
	return { ...base, ...endpointFields(kind, baseUrl) };
}

/**
 * The env fallback's target, or null when the environment configures no AI.
 * The env plane always uses the OpenAI adapter; its endpoint tells the native
 * API, OpenRouter, Ollama and a custom server apart. Locality and the revision
 * probe follow the ledger's rule on that URL, not `LLM_PROVIDER`: a local
 * Ollama behind `LLM_PROVIDER=openai` is local and probed all the same.
 */
export function envEmbeddingTarget(): EmbeddingTarget | null {
	if (!isEnvAiProviderConfigured()) return null;
	return {
		provider: 'openai',
		model: envEmbeddingModel(),
		requestedDimensions: 'native',
		source: 'env',
		...endpointFields('openai', envLlmBaseUrl()),
	};
}

/** The target vectors are written in today: the stored row's, else the env fallback's. */
export function configuredEmbeddingTarget(
	row: StoredEmbeddingSelection | null
): EmbeddingTarget | null {
	return row ? storedEmbeddingTarget(row) : envEmbeddingTarget();
}

export function isSameEmbeddingTarget(a: EmbeddingTarget, b: EmbeddingTarget): boolean {
	return embeddingTargetKey(a) === embeddingTargetKey(b);
}

/**
 * The canonical key of a configured target: the configured half of a space's
 * identity (provider, secret-free endpoint, model, requested width), a JSON
 * array like `embeddingSpaceIdentityKey`. Two targets are the same exactly
 * when their keys are. Holds no credential: the endpoint is its identity.
 */
export function embeddingTargetKey(target: EmbeddingTarget): string {
	return JSON.stringify([
		target.provider,
		target.endpoint,
		target.model,
		target.requestedDimensions,
	]);
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
 * staged rebuild replaces its vectors (post-provenance).
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
