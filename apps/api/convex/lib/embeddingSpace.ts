/**
 * Which embedding space the deployment writes vectors in, and the rule that
 * keeps a populated corpus in that space (AI routing plan, owner decision D8,
 * the pre-provenance half).
 *
 * Vectors carry no record of the model that made them yet, so retrieval cannot
 * tell two spaces apart: a switch would mix incomparable vectors in one index,
 * and zero-padding to the index width hides the damage instead of raising it.
 * Until provenance and the retrieval filter land, the server therefore refuses
 * to change the resolved space while the knowledge or file corpus holds
 * vectors, and an unrelated save keeps the stored space.
 *
 * A space is the provider, the resolved model and the width requested from the
 * provider. Everything here is pure or reads the database, so the v8 settings
 * mutation and the Node resolver (`lib/llmProvider.ts`) share one definition.
 */

import {
	GOOGLE_EMBEDDING_DEFAULT,
	LEGACY_GOOGLE_EMBEDDING_MODEL,
} from '@owlat/shared/aiModelCatalog';
import type { DatabaseReader } from '../_generated/server';
import { throwConflict, throwInvalidInput } from '../_utils/errors';
import { isEnvAiProviderConfigured } from './aiNotConfigured';
import { CURRENT_EMBEDDING_MODEL } from './constants';
import { getOptional } from './env';
import { classifyEnvLanguageEndpoint, type EmbeddingProviderKind } from './llmProviders/types';

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

export interface EmbeddingSpace {
	/** The stored embedding kind, or `env:<endpoint>` for a non-OpenAI env endpoint. */
	readonly provider: string;
	readonly modelId: string;
	readonly dimensions: number | 'native';
}

export function storedEmbeddingSpace(selection: StoredEmbeddingSelection): EmbeddingSpace {
	const kind = selection.embeddingProviderKind;
	const modelId = resolveStoredEmbeddingModel(selection);
	return { provider: kind, modelId, dimensions: requestedEmbeddingDimensions(kind, modelId) };
}

/**
 * The env fallback's space, or null when the environment configures no AI. The
 * env plane always uses the OpenAI wire; only the native OpenAI endpoint is the
 * same space as a stored `openai` embedder with the same model.
 */
export function envEmbeddingSpace(): EmbeddingSpace | null {
	if (!isEnvAiProviderConfigured()) return null;
	const endpoint = classifyEnvLanguageEndpoint(
		getOptional('LLM_PROVIDER'),
		Boolean(getOptional('LLM_BASE_URL'))
	);
	return {
		provider: endpoint === 'openai-native' ? 'openai' : `env:${endpoint}`,
		modelId: envEmbeddingModel(),
		dimensions: 'native',
	};
}

/** The space vectors are written in today: the stored row's, else the env fallback's. */
export function resolvedEmbeddingSpace(
	row: StoredEmbeddingSelection | null
): EmbeddingSpace | null {
	return row ? storedEmbeddingSpace(row) : envEmbeddingSpace();
}

export function isSameEmbeddingSpace(a: EmbeddingSpace, b: EmbeddingSpace): boolean {
	return a.provider === b.provider && a.modelId === b.modelId && a.dimensions === b.dimensions;
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
 * Newest rows read per corpus table. Rows wait with an empty `embedding` until
 * the pipeline fills them, so a window holding no vector is inconclusive when it
 * is full, and counts as populated: the check fails closed without a scan.
 */
export const VECTOR_PROBE_ROWS = 8;

async function tableMayHoldVectors(
	db: DatabaseReader,
	table: 'knowledgeEntries' | 'semanticFiles'
): Promise<boolean> {
	const newest = await db
		.query(table)
		.withIndex('by_created_at')
		.order('desc')
		.take(VECTOR_PROBE_ROWS); // bounded: fixed probe window
	return newest.some((row) => row.embedding.length > 0) || newest.length === VECTOR_PROBE_ROWS;
}

/** Whether the knowledge or file corpus may hold vectors (bounded, fails closed). */
export async function corpusMayHoldVectors(db: DatabaseReader): Promise<boolean> {
	return (
		(await tableMayHoldVectors(db, 'knowledgeEntries')) ||
		(await tableMayHoldVectors(db, 'semanticFiles'))
	);
}

/** `data.reason` on the conflict error, for clients that explain the refusal. */
export const EMBEDDING_SPACE_LOCKED = 'embedding_space_locked';

function describeSpace(space: EmbeddingSpace): string {
	const width = space.dimensions === 'native' ? '' : `, ${space.dimensions} dimensions`;
	return `${space.provider} / ${space.modelId}${width}`;
}

/**
 * Refuse a change of embedding space while the corpus may hold vectors. With no
 * current space (no row and no env AI) there is nothing to compare: that is a
 * first setup. Removal keeps the row while vectors exist
 * ({@link assertRemovalKeepsEmbeddingSpace}), so Owlat itself never reaches that
 * state with vectors present; an env fallback unset outside Owlat, or a row
 * removed before this check existed, still can.
 */
export async function assertEmbeddingSpaceChangeAllowed(
	db: DatabaseReader,
	current: EmbeddingSpace | null,
	next: EmbeddingSpace | null
): Promise<void> {
	if (!current || !next || isSameEmbeddingSpace(current, next)) return;
	if (!(await corpusMayHoldVectors(db))) return;
	throwConflict(
		`The embedding model can't change while the knowledge base or file library holds ` +
			`vectors. Vectors from ${describeSpace(current)} and ${describeSpace(next)} are not ` +
			`comparable, and Owlat can't re-embed existing vectors yet. Keep the current ` +
			`embedding provider and model.`,
		{ reason: EMBEDDING_SPACE_LOCKED, current: { ...current }, requested: { ...next } }
	);
}

/**
 * The `embeddingModelVersion` a settings save writes, after refusing a
 * populated-corpus space change. The version moves only when the resolved space
 * does, so resubmitting the model an absent field already resolved to is a no-op.
 */
export async function nextEmbeddingModelVersion(
	db: DatabaseReader,
	existing: (StoredEmbeddingSelection & { readonly embeddingModelVersion: number }) | null,
	selection: StoredEmbeddingSelection
): Promise<number> {
	const current = resolvedEmbeddingSpace(existing);
	const next = storedEmbeddingSpace(selection);
	await assertEmbeddingSpaceChangeAllowed(db, current, next);
	if (!existing) return 1;
	return existing.embeddingModelVersion + (current && isSameEmbeddingSpace(current, next) ? 0 : 1);
}

/**
 * Removing the stored row discards the only record of the space its vectors are
 * in: the env fallback takes over, or, with no env AI, nothing does and the next
 * save would have no space to compare with. So removal is refused while the
 * corpus may hold vectors, unless the env fallback resolves the same space.
 * Turning the AI features off (feature flags) is the way to stop AI without
 * forgetting the space.
 */
export async function assertRemovalKeepsEmbeddingSpace(
	db: DatabaseReader,
	row: StoredEmbeddingSelection
): Promise<void> {
	const current = storedEmbeddingSpace(row);
	const fallback = envEmbeddingSpace();
	if (fallback) {
		await assertEmbeddingSpaceChangeAllowed(db, current, fallback);
		return;
	}
	if (!(await corpusMayHoldVectors(db))) return;
	throwConflict(
		`The AI provider configuration can't be removed while the knowledge base or file ` +
			`library holds vectors: it is the only record of the embedding model ` +
			`(${describeSpace(current)}) those vectors came from. To stop using AI, turn the AI ` +
			`features off instead.`,
		{ reason: EMBEDDING_SPACE_LOCKED, current: { ...current }, requested: null }
	);
}

// ── Vector commits ─────────────────────────────────────────────────────────

/** The key of "no resolvable space": no stored row and no env AI. */
export const NO_EMBEDDING_SPACE_KEY = 'none';

/**
 * A stable key for a resolved space. An embedding job captures it when it
 * resolves its model (`resolveIndexEmbedder`) and hands it to the mutation that
 * commits the vector. Phase 0 stand-in: the embed lane replaces it with the
 * contract's `embeddingSpaceId`, behind {@link vectorFieldsForCommit}.
 */
export function embeddingSpaceKey(space: EmbeddingSpace | null): string {
	return space
		? JSON.stringify([space.provider, space.modelId, space.dimensions])
		: NO_EMBEDDING_SPACE_KEY;
}

/** The deployment's current space key, read in the committing transaction. */
async function currentEmbeddingSpaceKey(db: DatabaseReader): Promise<string> {
	const row = await db.query('aiProviderConfig').first(); // bounded: org singleton
	return embeddingSpaceKey(resolvedEmbeddingSpace(row));
}

/** The vector columns a corpus row carries. */
export interface VectorFields {
	embedding: number[];
	embeddingModel?: string;
	embeddingGeneratedAt?: number;
}

/**
 * THE vector-commit check. Every mutation that writes a vector into the
 * knowledge or file corpus passes the space key its job embedded with, and
 * writes what this returns. A vector from a space that is no longer current (the
 * settings changed while the job ran, or an isolate used a cached config) is
 * dropped: the row is stored without one (`embedding: []`), so it reads as not
 * yet embedded and the next processing pass embeds it in the current space.
 */
export async function vectorFieldsForCommit(
	db: DatabaseReader,
	vector: VectorFields,
	jobEmbeddingSpaceKey: string
): Promise<VectorFields & { isStale: boolean }> {
	if (vector.embedding.length === 0) return { ...vector, isStale: false };
	if (jobEmbeddingSpaceKey === (await currentEmbeddingSpaceKey(db))) {
		return { ...vector, isStale: false };
	}
	return {
		embedding: [],
		embeddingModel: undefined,
		embeddingGeneratedAt: undefined,
		isStale: true,
	};
}
