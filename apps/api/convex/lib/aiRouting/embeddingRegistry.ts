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
 * Make a space the active one, atomically: the previous active space is
 * retired (its vectors stay in its column for rollback), a staged rebuild for
 * any other space ends, and jobs that target a space no longer active or staged
 * are cancelled. `existing` reactivates or promotes a known space; `identity`
 * registers a new one in the slot the active space does not use.
 */
export async function activateSpace(
	ctx: MutationCtx,
	space: { existing: SpaceDoc } | { identity: MeasuredSpace; configVersion?: number }
): Promise<SpaceDoc> {
	const now = Date.now();
	const active = await readActiveSpace(ctx.db);
	const staged = await readStagedSpace(ctx.db);
	const existing = 'existing' in space ? space.existing : null;
	if (active && active._id !== existing?._id) {
		await ctx.db.patch(active._id, { state: 'retired', retiredAt: now, updatedAt: now });
	}
	if (staged && staged._id !== existing?._id) {
		await ctx.db.patch(staged._id, { state: 'retired', retiredAt: now, updatedAt: now });
	}
	let spaceId: SpaceId;
	if (existing) {
		await ctx.db.patch(existing._id, {
			state: 'active',
			activatedAt: now,
			retiredAt: undefined,
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
	secondaryEmbedding?: number[];
	secondaryEmbeddingSpaceId?: SpaceId;
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

/** The columns that put `vector` into `space`'s slot, stamped `provenance`. */
export function slotFields(
	space: SpaceDoc,
	vector: number[],
	options: {
		now: number;
		entryType?: EntryType;
		provenance?: EmbeddingProvenanceSource;
	}
): Record<string, unknown> {
	const { now, entryType } = options;
	if (space.slot === 'primary') {
		return {
			embedding: vector,
			embeddingModel: space.model,
			embeddingGeneratedAt: now,
			embeddingSpaceId: space._id,
			embeddingProvenance: options.provenance ?? 'measured',
			embeddingAttestationId: undefined,
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
 * the space registered for `identity`. Only the active space unless
 * `allowStaged` (the rebuild's validation). Null means the vector leg has
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
	if (space.state === 'active' || (query.allowStaged && space.state === 'staged')) {
		return spaceRefOf(space);
	}
	return null;
}
