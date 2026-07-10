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
	LANGUAGE_PROVIDER_KINDS,
	type EmbeddingProviderKind,
	type LanguageProviderKind,
} from './llmProviders/types';

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
 * Stored embedding-provider kind. The embedding plane is LOCAL BY DEFAULT (a
 * bundled local embedder resolved independently of the language provider), so
 * `'local'` is a valid stored kind alongside every registered hosted embedding
 * adapter. The bundled local embedder is wired into the embedding registry by a
 * later plan piece; storing the selection here is decoupled from resolving it.
 */
export type StoredEmbeddingProviderKind = 'local' | EmbeddingProviderKind;
export const embeddingProviderKindValidator = v.union(
	v.literal('local'),
	...EMBEDDING_PROVIDER_KINDS.map((kind) => v.literal(kind))
) as unknown as Validator<StoredEmbeddingProviderKind>;
