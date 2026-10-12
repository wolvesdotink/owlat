/**
 * Embedding spaces in the database (ADR-0073, Phase 1a provenance, D8 and the
 * Phase 5 rebuild): the reads, and which vector of a row belongs to which
 * space. The writes (activation, column claims, commits) are in
 * `embeddingActivation.ts`.
 *
 * The rules every reader and writer shares:
 *
 *   - A row's `embedding` column belongs to `embeddingSpaceId`, its
 *     `secondaryEmbedding` column to `secondaryEmbeddingSpaceId`, each stamped in
 *     the same write as its vector. No column is ever compared with a vector of
 *     another space: retrieval filters each vector index by the space id of the
 *     query vector (`knowledge/vectorSearch.ts`).
 *   - A space's `slot` names the column its vectors are in. Each column has one
 *     owner: the space with that slot and the highest `columnClaim`. Only the
 *     owner may write a column, and a space's stored vectors are reused (on a
 *     reactivation or a rollback) only while it still owns their column; a
 *     space that lost its column is superseded and re-embedded.
 *   - The searchable space is the active one while the configuration names it.
 *     A row with no space is unknown: lexical search only.
 *   - A change to a row's embedding input clears every column the same
 *     mutation does not write, so no column keeps a vector of old content.
 *
 * v8-safe: commit mutations, retrieval queries and the jobs share it.
 */

import type { EmbeddingProvenanceSource } from '@owlat/shared/aiRouting';
import type { Doc, Id } from '../../_generated/dataModel';
import type { DatabaseReader } from '../../_generated/server';
import type { entryTypeValidator } from '../../schema/knowledge';
import type { Infer } from 'convex/values';
import { configuredEmbeddingTarget, type EmbeddingTarget } from '../embeddingSpace';
import {
	embeddingSpaceEntryKey,
	embeddingSpaceIdentityKey,
	type EmbeddingSpaceIdentity,
} from './embeddingKeys';

export type SpaceDoc = Doc<'embeddingSpaces'>;
type SpaceId = Id<'embeddingSpaces'>;
type EntryType = Infer<typeof entryTypeValidator>;
export type EmbeddingSlot = SpaceDoc['slot'];

/** A complete space identity as a job measured it, plus where its target came from. */
export type MeasuredSpace = EmbeddingSpaceIdentity & { source: 'stored_config' | 'env' };

/** Which column and which space id a vector search filters on. */
export interface SpaceRef {
	readonly spaceId: SpaceId;
	readonly slot: EmbeddingSlot;
}

export function spaceRefOf(space: Pick<SpaceDoc, '_id' | 'slot'>): SpaceRef {
	return { spaceId: space._id, slot: space.slot };
}

export function otherSlot(slot: EmbeddingSlot): EmbeddingSlot {
	return slot === 'primary' ? 'secondary' : 'primary';
}

export function identityOf(space: SpaceDoc): EmbeddingSpaceIdentity {
	return {
		provider: space.provider,
		endpoint: space.endpoint,
		model: space.model,
		dimensions: space.dimensions,
		...(space.revision !== undefined ? { revision: space.revision } : {}),
		...(space.quantization !== undefined ? { quantization: space.quantization } : {}),
	};
}

export async function readActiveSpace(db: DatabaseReader): Promise<SpaceDoc | null> {
	return db
		.query('embeddingSpaces')
		.withIndex('by_state', (q) => q.eq('state', 'active'))
		.first();
}

export async function readStagedSpace(db: DatabaseReader): Promise<SpaceDoc | null> {
	return db
		.query('embeddingSpaces')
		.withIndex('by_state', (q) => q.eq('state', 'staged'))
		.first();
}

export async function readSpaceByIdentity(
	db: DatabaseReader,
	identity: EmbeddingSpaceIdentity
): Promise<SpaceDoc | null> {
	const key = embeddingSpaceIdentityKey(identity);
	return db
		.query('embeddingSpaces')
		.withIndex('by_identity_key', (q) => q.eq('identityKey', key))
		.first();
}

/** The configured target, read in the calling transaction. */
export async function readConfiguredTarget(db: DatabaseReader): Promise<EmbeddingTarget | null> {
	return configuredEmbeddingTarget(await db.query('aiProviderConfig').first()); // bounded: org singleton
}

/** Whether a measured identity is the target's space (the configured part matches). */
export function isIdentityOfTarget(
	identity: EmbeddingSpaceIdentity,
	target: EmbeddingTarget
): boolean {
	return (
		identity.provider === target.provider &&
		identity.endpoint === target.endpoint &&
		identity.model === target.model &&
		(target.requestedDimensions === 'native' || identity.dimensions === target.requestedDimensions)
	);
}

/**
 * The space vector search may use: the active space, and only while the
 * configuration still names it. After a switch the old space stays `active`
 * until the new one's first vector lands, but nothing may search it: a query
 * embedded now is in the new space, and a stored vector of the old one belongs
 * to a corpus the configuration has left.
 */
export async function readSearchableSpace(db: DatabaseReader): Promise<SpaceDoc | null> {
	const active = await readActiveSpace(db);
	if (!active) return null;
	const target = await readConfiguredTarget(db);
	return target && isIdentityOfTarget(identityOf(active), target) ? active : null;
}

/** Every space, for the column-ownership reads (a handful of rows). */
export async function readAllSpaces(db: DatabaseReader): Promise<SpaceDoc[]> {
	return db.query('embeddingSpaces').take(500); // bounded: one row per space ever configured
}

/** The space that owns `slot`: the one there with the highest claim, or null. */
export function columnOwnerOf(spaces: readonly SpaceDoc[], slot: EmbeddingSlot): SpaceDoc | null {
	let owner: SpaceDoc | null = null;
	for (const space of spaces) {
		if (space.slot !== slot) continue;
		if (!owner || (space.columnClaim ?? 0) > (owner.columnClaim ?? 0)) owner = space;
	}
	return owner;
}

/** Whether `space` still owns its column (its stored vectors there are its own). */
export async function ownsColumn(db: DatabaseReader, space: SpaceDoc): Promise<boolean> {
	return columnOwnerOf(await readAllSpaces(db), space.slot)?._id === space._id;
}

// ── The two vector columns of a row ─────────────────────────────────────────

/** The vector columns and stamps of a `knowledgeEntries` or `semanticFiles` row. */
export interface VectorColumns {
	embedding: number[];
	embeddingSpaceId?: SpaceId;
	embeddingGeneratedAt?: number;
	embeddingProvenance?: EmbeddingProvenanceSource;
	embeddingAttestationId?: Id<'embeddingAttestations'>;
	secondaryEmbedding?: number[];
	secondaryEmbeddingSpaceId?: SpaceId;
	secondaryEmbeddingGeneratedAt?: number;
}

/** The row's vector in `ref`'s space, or null: never a vector of another space. */
export function vectorInSpace(row: VectorColumns, ref: SpaceRef): number[] | null {
	if (ref.slot === 'primary') {
		return row.embeddingSpaceId === ref.spaceId && row.embedding.length > 0 ? row.embedding : null;
	}
	const vector = row.secondaryEmbedding;
	return row.secondaryEmbeddingSpaceId === ref.spaceId && vector && vector.length > 0
		? vector
		: null;
}

export type RowCoverage = 'active' | 'unknown' | 'inactive' | 'unembedded';

/** Where a row stands against the active space (for the coverage counts and the re-embed walk). */
export function rowCoverage(row: VectorColumns, active: SpaceRef | null): RowCoverage {
	if (active && vectorInSpace(row, active)) return 'active';
	if (row.embedding.length > 0 && row.embeddingSpaceId === undefined) return 'unknown';
	const hasPrimary = row.embedding.length > 0;
	const hasSecondary = (row.secondaryEmbedding?.length ?? 0) > 0;
	return hasPrimary || hasSecondary ? 'inactive' : 'unembedded';
}

/** The composite filter keys of a knowledge entry after its type changes. */
export function entryKeysForType(
	row: Pick<VectorColumns, 'embeddingSpaceId' | 'secondaryEmbeddingSpaceId'>,
	entryType: EntryType
): { embeddingSpaceEntryKey?: string; secondaryEmbeddingSpaceEntryKey?: string } {
	return {
		embeddingSpaceEntryKey: row.embeddingSpaceId
			? embeddingSpaceEntryKey(row.embeddingSpaceId, entryType)
			: undefined,
		secondaryEmbeddingSpaceEntryKey: row.secondaryEmbeddingSpaceId
			? embeddingSpaceEntryKey(row.secondaryEmbeddingSpaceId, entryType)
			: undefined,
	};
}

/** The columns that put `vector` into `space`'s slot, stamped with its provenance. */
export function slotFields(
	space: Pick<SpaceDoc, '_id' | 'slot' | 'model'>,
	vector: number[],
	options: {
		now: number;
		entryType?: EntryType;
		provenance?: EmbeddingProvenanceSource;
		attestationId?: Id<'embeddingAttestations'>;
	}
): Record<string, unknown> {
	const { now, entryType } = options;
	const provenance = options.provenance ?? 'measured';
	if (space.slot === 'primary') {
		return {
			embedding: vector,
			embeddingModel: space.model,
			embeddingGeneratedAt: now,
			embeddingSpaceId: space._id,
			embeddingProvenance: provenance,
			embeddingAttestationId: options.attestationId,
			...(entryType
				? { embeddingSpaceEntryKey: embeddingSpaceEntryKey(space._id, entryType) }
				: {}),
		};
	}
	return {
		secondaryEmbedding: vector,
		secondaryEmbeddingSpaceId: space._id,
		secondaryEmbeddingGeneratedAt: now,
		...(entryType
			? { secondaryEmbeddingSpaceEntryKey: embeddingSpaceEntryKey(space._id, entryType) }
			: {}),
	};
}

/** The fields that clear one column of a row (and its filter key, for knowledge). */
export function clearColumnFields(
	slot: EmbeddingSlot,
	options: { isKnowledge: boolean }
): Record<string, unknown> {
	if (slot === 'primary') {
		return {
			embedding: [],
			embeddingModel: undefined,
			embeddingGeneratedAt: undefined,
			embeddingSpaceId: undefined,
			embeddingProvenance: undefined,
			embeddingAttestationId: undefined,
			...(options.isKnowledge ? { embeddingSpaceEntryKey: undefined } : {}),
		};
	}
	return {
		secondaryEmbedding: undefined,
		secondaryEmbeddingSpaceId: undefined,
		secondaryEmbeddingGeneratedAt: undefined,
		...(options.isKnowledge ? { secondaryEmbeddingSpaceEntryKey: undefined } : {}),
	};
}

/**
 * THE input-change rule: the fields that clear every column of a row except
 * `written` (the column the same mutation writes a fresh vector into, if any).
 * Every mutation that changes a row's embedding input (title, content, summary,
 * extracted text) applies it, so no column ever holds a vector of old content.
 */
export function inputChangeFields(
	written: EmbeddingSlot | null,
	options: { isKnowledge: boolean }
): Record<string, unknown> {
	return {
		...(written === 'primary' ? {} : clearColumnFields('primary', options)),
		...(written === 'secondary' ? {} : clearColumnFields('secondary', options)),
	};
}

/**
 * The space and column a vector search filters on: the space named by id, or
 * the space registered for `identity`. Only the searchable space (active AND
 * still the configured target, `readSearchableSpace`), or the staged space
 * when `allowStaged` (the rebuild's validation). Null means the vector leg has
 * nothing comparable to search.
 */
export async function resolveSearchTarget(
	db: DatabaseReader,
	query: { spaceId?: SpaceId; identity?: EmbeddingSpaceIdentity; allowStaged?: boolean }
): Promise<SpaceRef | null> {
	const space = query.spaceId
		? await db.get(query.spaceId)
		: query.identity
			? await readSpaceByIdentity(db, query.identity)
			: null;
	if (!space) return null;
	if (query.allowStaged && space.state === 'staged') return spaceRefOf(space);
	const searchable = await readSearchableSpace(db);
	return searchable?._id === space._id ? spaceRefOf(searchable) : null;
}
