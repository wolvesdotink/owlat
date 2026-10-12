/**
 * Embedding spaces in the database (ADR-0073, Phase 1a provenance, D8 and the
 * Phase 5 rebuild): which space is active, how a vector is stamped when it is
 * committed, and which vector of a row belongs to which space.
 *
 * The rules every reader and writer shares:
 *
 *   - A row's `embedding` column belongs to `embeddingSpaceId`, its
 *     `secondaryEmbedding` column to `secondaryEmbeddingSpaceId`. No column is
 *     ever compared with a vector of another space: retrieval filters each
 *     vector index by the space id of the query vector (`knowledge/retrieval.ts`).
 *   - A space's `slot` names the column its new vectors are written to and the
 *     index retrieval searches for it. A new space takes the slot the active one
 *     does not use, so the previous space's vectors survive a switch (rollback,
 *     and A → B → A without re-embedding).
 *   - The active space is the configured one. A commit whose space matches the
 *     configuration activates that space when it is not active yet; a commit
 *     from a job that embedded under an older configuration is stale and its
 *     vector is dropped. A row with no space is unknown: lexical search only.
 *
 * v8-safe: commit mutations, retrieval queries and the jobs share it.
 */

import type { EmbeddingProvenanceSource } from '@owlat/shared/aiRouting';
import { internal } from '../../_generated/api';
import type { Doc, Id } from '../../_generated/dataModel';
import type { DatabaseReader, MutationCtx } from '../../_generated/server';
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

/** End the running or paused re-embed jobs that `keep` rejects. */
async function cancelJobs(
	ctx: MutationCtx,
	keep: (job: Doc<'embeddingReembedJobs'>) => boolean,
	now: number
): Promise<void> {
	for (const status of ['running', 'paused'] as const) {
		const jobs = await ctx.db
			.query('embeddingReembedJobs')
			.withIndex('by_status', (q) => q.eq('status', status))
			.take(20);
		for (const job of jobs) {
			if (keep(job)) continue;
			await ctx.db.patch(job._id, {
				status: 'cancelled',
				pausedReason: 'space_changed',
				generation: job.generation + 1,
				finishedAt: now,
				updatedAt: now,
			});
		}
	}
}

/**
 * The configured target moved (a settings save or removal): end every
 * re-embed job, so no batch an old generation scheduled writes into a space the
 * configuration has left. A staged rebuild keeps running; it targets its own
 * space, and activating it rewrites the configuration anyway.
 */
export async function endReembedJobs(ctx: MutationCtx): Promise<void> {
	await cancelJobs(ctx, (job) => job.kind !== 'reembed', Date.now());
}

/**
 * Put a space's vectors in `slot`. Its rows keep their vectors in the other
 * column until the bounded copy (`aiRouting/embeddingSlotMigration.ts`) moves
 * them, with their provenance; the re-embed job leaves those rows to the copy.
 * Nothing is overwritten that belongs to the space now using the other column.
 */
export async function reslotSpace(
	ctx: MutationCtx,
	space: SpaceDoc,
	slot: EmbeddingSlot
): Promise<void> {
	if (space.slot === slot) return;
	await ctx.db.patch(space._id, { slot, updatedAt: Date.now() });
	await ctx.scheduler.runAfter(0, internal.aiRouting.embeddingSlotMigration.migratePage, {
		spaceId: space._id,
		table: 'knowledgeEntries',
		cursor: null,
	});
}

/**
 * Make a space the active one, atomically: the previous active space is
 * retired with its vectors intact and recorded as the new space's
 * `predecessorSpaceId` (the rollback target), a staged rebuild for any other
 * space ends, and jobs that target a space no longer active or staged are
 * cancelled. The incoming space always takes the column the outgoing one does
 * not use: a known space in the same column is re-slotted and its vectors
 * copied over (`reslotSpace`), so the outgoing space's vectors are never
 * re-embedded over. `existing` reactivates or promotes a known space;
 * `identity` registers a new one.
 */
export async function activateSpace(
	ctx: MutationCtx,
	space: { existing: SpaceDoc } | { identity: MeasuredSpace; configVersion?: number }
): Promise<SpaceDoc> {
	const now = Date.now();
	const active = await readActiveSpace(ctx.db);
	const staged = await readStagedSpace(ctx.db);
	const existing = 'existing' in space ? space.existing : null;
	const outgoing = active && active._id !== existing?._id ? active : null;
	if (outgoing) {
		await ctx.db.patch(outgoing._id, { state: 'retired', retiredAt: now, updatedAt: now });
	}
	if (staged && staged._id !== existing?._id) {
		await ctx.db.patch(staged._id, { state: 'retired', retiredAt: now, updatedAt: now });
	}
	let spaceId: SpaceId;
	if (existing) {
		if (outgoing && existing.slot === outgoing.slot) {
			await reslotSpace(ctx, existing, otherSlot(outgoing.slot));
		}
		await ctx.db.patch(existing._id, {
			state: 'active',
			activatedAt: now,
			retiredAt: undefined,
			...(outgoing ? { predecessorSpaceId: outgoing._id } : {}),
			updatedAt: now,
		});
		spaceId = existing._id;
	} else {
		const { source, ...identity } = (space as { identity: MeasuredSpace }).identity;
		spaceId = await ctx.db.insert('embeddingSpaces', {
			...identity,
			identityKey: embeddingSpaceIdentityKey(identity),
			source,
			state: 'active',
			slot: active ? otherSlot(active.slot) : 'primary',
			...(active ? { predecessorSpaceId: active._id } : {}),
			configVersion: (space as { configVersion?: number }).configVersion,
			activatedAt: now,
			createdAt: now,
			updatedAt: now,
		});
	}
	await cancelJobs(ctx, (job) => job.targetSpaceId === spaceId && job.kind === 'reembed', now);
	// A local embedder re-embeds right away; a hosted one waits for an admin (D8).
	await ctx.scheduler.runAfter(0, internal.aiRouting.embeddingReembed.kickoff, { isForced: true });
	return (await ctx.db.get(spaceId))!;
}

/** End a staged rebuild: the staged space retires and its job is cancelled. */
export async function retireStagedSpace(ctx: MutationCtx, staged: SpaceDoc): Promise<void> {
	const now = Date.now();
	await ctx.db.patch(staged._id, { state: 'retired', retiredAt: now, updatedAt: now });
	await cancelJobs(ctx, (job) => job.targetSpaceId !== staged._id, now);
}

/**
 * The active space for a vector a job measured, registering and activating it
 * when the configuration names it (the D8 switch path). Null when the job's
 * target is no longer the configured one: its vector is stale.
 */
export async function ensureConfiguredSpace(
	ctx: MutationCtx,
	measured: MeasuredSpace
): Promise<SpaceDoc | null> {
	const target = await readConfiguredTarget(ctx.db);
	if (!target || !isIdentityOfTarget(measured, target)) return null;
	const existing = await readSpaceByIdentity(ctx.db, measured);
	if (existing?.state === 'active') return existing;
	const config = await ctx.db.query('aiProviderConfig').first(); // bounded: org singleton
	return existing
		? activateSpace(ctx, { existing })
		: activateSpace(ctx, { identity: measured, configVersion: config?.embeddingModelVersion });
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
	secondaryEmbeddingProvenance?: EmbeddingProvenanceSource;
	secondaryEmbeddingAttestationId?: Id<'embeddingAttestations'>;
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
		secondaryEmbeddingProvenance: provenance,
		secondaryEmbeddingAttestationId: options.attestationId,
		...(entryType
			? { secondaryEmbeddingSpaceEntryKey: embeddingSpaceEntryKey(space._id, entryType) }
			: {}),
	};
}

/**
 * The columns that copy a row's vector of `space` from the other column into
 * `space`'s slot, keeping when and how it was made. Null when the other column
 * holds no vector of that space.
 */
export function copyFieldsIntoSlot(
	row: VectorColumns,
	space: Pick<SpaceDoc, '_id' | 'slot' | 'model'>,
	entryType?: EntryType
): Record<string, unknown> | null {
	const from = otherSlot(space.slot);
	const vector = vectorInSpace(row, { spaceId: space._id, slot: from });
	if (!vector) return null;
	const isPrimary = from === 'primary';
	return slotFields(space, vector, {
		now: (isPrimary ? row.embeddingGeneratedAt : row.secondaryEmbeddingGeneratedAt) ?? Date.now(),
		entryType,
		provenance: isPrimary ? row.embeddingProvenance : row.secondaryEmbeddingProvenance,
		attestationId: isPrimary ? row.embeddingAttestationId : row.secondaryEmbeddingAttestationId,
	});
}

/** Every vector column cleared (a row stored without a vector). */
function clearedFields(mode: 'insert' | 'patch', entryType?: EntryType): Record<string, unknown> {
	const primary = {
		embedding: [],
		embeddingModel: undefined,
		embeddingGeneratedAt: undefined,
		embeddingSpaceId: undefined,
		embeddingProvenance: undefined,
		embeddingAttestationId: undefined,
		...(entryType ? { embeddingSpaceEntryKey: undefined } : {}),
	};
	if (mode === 'insert') return primary;
	return {
		...primary,
		secondaryEmbedding: undefined,
		secondaryEmbeddingSpaceId: undefined,
		secondaryEmbeddingGeneratedAt: undefined,
		secondaryEmbeddingProvenance: undefined,
		secondaryEmbeddingAttestationId: undefined,
		...(entryType ? { secondaryEmbeddingSpaceEntryKey: undefined } : {}),
	};
}

/**
 * THE vector-commit step. Every mutation that writes a freshly embedded vector
 * into the knowledge or file corpus passes the space the job measured and
 * writes the fields this returns (`insert` for a new row, `patch` for an
 * update). The vector lands in the active space's column, stamped with its
 * space and `measured` provenance, and with the model that really made it.
 *
 * An empty vector clears the row's vectors (today's "no vector" state). A
 * vector without a measured space (a previous-release job) or from a target the
 * configuration no longer names (the settings changed while the job ran) is
 * dropped the same way: the row reads as not yet embedded, and the next pass or
 * the re-embed job embeds it in the current space.
 */
export async function vectorFieldsForCommit(
	ctx: MutationCtx,
	commit: { embedding: number[]; space: MeasuredSpace | undefined },
	options: { mode: 'insert' | 'patch'; entryType?: EntryType }
): Promise<{ fields: Record<string, unknown>; isStale: boolean }> {
	if (commit.embedding.length === 0) {
		return { fields: clearedFields(options.mode, options.entryType), isStale: false };
	}
	// Remove the optional space after release N+1 (CONVENTIONS "Old clients and workers").
	const space = commit.space ? await ensureConfiguredSpace(ctx, commit.space) : null;
	if (!space) return { fields: clearedFields(options.mode, options.entryType), isStale: true };
	const fields = slotFields(space, commit.embedding, {
		now: Date.now(),
		entryType: options.entryType,
	});
	// A new row in the secondary slot still needs its (empty) primary column.
	if (options.mode === 'insert' && space.slot === 'secondary') {
		return { fields: { ...clearedFields('insert', options.entryType), ...fields }, isStale: false };
	}
	return { fields, isStale: false };
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
