/**
 * Shared Convex validators for the pluggable AI-providers config table.
 *
 * The language / embedding provider-kind unions are DERIVED from the adapter
 * registry's runtime kind tuples (`lib/llmProviders/types`) so the stored
 * `aiProviderConfig` shape and the registry stay a single source of truth —
 * adding a provider adapter widens both at once. Kept in this pure (no
 * `'use node'`) module so both `schema/auth.ts` and the config functions
 * (v8 + Node) can import it without pulling in `node:crypto` or the AI SDK.
 */

import { v, type Validator } from 'convex/values';
import {
	EMBEDDING_PROVIDER_KINDS,
	LANGUAGE_ENDPOINT_PROVENANCES,
	LANGUAGE_PROVIDER_KINDS,
	type EmbeddingProviderKind,
	type LanguageEndpointProvenance,
	type LanguageProviderKind,
} from './llmProviders/types';

/** Secret-free endpoint identity used by hard-budget admission accounting. */
export const languageEndpointProvenanceValidator = v.union(
	...LANGUAGE_ENDPOINT_PROVENANCES.map((provenance) => v.literal(provenance))
) as unknown as Validator<LanguageEndpointProvenance>;

/**
 * Stored language-provider kind — every registered language adapter (hosted
 * OpenAI / Anthropic / Google / OpenRouter, plus the local OpenAI-compatible
 * adapter). The variadic spread loses literal narrowing, so we cast back to the
 * registry's `LanguageProviderKind` once here (mirrors `auditActions/catalog`).
 */
export const languageProviderKindValidator = v.union(
	...LANGUAGE_PROVIDER_KINDS.map((kind) => v.literal(kind))
) as unknown as Validator<LanguageProviderKind>;

/**
 * Stored embedding-provider kind — every registered embedding adapter. The
 * embedding plane is LOCAL BY DEFAULT: `'local'` is the first registered kind
 * (a local embedder resolved INDEPENDENTLY of the language provider), alongside
 * the optional hosted overrides (`openai` / `google`) and a custom
 * `openaiCompatible` server. Derived from the registry's kind tuple so the
 * stored shape and the adapter registry stay a single source of truth. Retained
 * as a named alias (rather than inlining `EmbeddingProviderKind`) so call sites
 * read as "the kind as stored on `aiProviderConfig`".
 */
export type StoredEmbeddingProviderKind = EmbeddingProviderKind;
export const embeddingProviderKindValidator = v.union(
	...EMBEDDING_PROVIDER_KINDS.map((kind) => v.literal(kind))
) as unknown as Validator<StoredEmbeddingProviderKind>;
