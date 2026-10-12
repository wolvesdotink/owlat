/**
 * The writes of embedding provenance (ADR-0073): activating a space, claiming
 * a vector column, committing a vector, and recording that the corpus changed.
 * The rules are in `embeddingRegistry.ts`; this module is the one that applies
 * them in mutations.
 *
 * Column claims. Every time a space takes a column (registered, activated,
 * staged, attested, or reused), it gets the next `columnClaim`, and the space
 * with the highest claim in a column owns it. A space whose stored vectors are
 * reused (a reactivation, a rollback, a re-stage) must still own their column;
 * otherwise another space has been writing there, so it is superseded: the old
 * row keeps its id (its stamped rows become inactive) under a retired identity,
 * and a fresh row with the same identity takes a column and is re-embedded.
 * Nothing is ever copied between columns.
 */

import { internal } from '../../_generated/api';
import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import type { Infer } from 'convex/values';
import type { entryTypeValidator } from '../../schema/knowledge';
import { resolveEndpointLocality } from '../llm/endpointLocality';
import { embeddingSpaceIdentityKey, type EmbeddingSpaceIdentity } from './embeddingKeys';
import {
	columnOwnerOf,
	identityOf,
	inputChangeFields,
	isIdentityOfTarget,
	otherSlot,
	readActiveSpace,
	readAllSpaces,
	readConfiguredTarget,
	readSpaceByIdentity,
	readStagedSpace,
	slotFields,
	type EmbeddingSlot,
	type MeasuredSpace,
	type SpaceDoc,
} from './embeddingRegistry';

type EntryType = Infer<typeof entryTypeValidator>;

/** Whether a space's endpoint is local (free) by the ledger's rule; unknown is hosted. */
export function isSpaceLocal(space: Pick<SpaceDoc, 'provider' | 'endpoint'>): boolean {
	const url = space.endpoint === 'native' ? undefined : space.endpoint;
	return resolveEndpointLocality(space.provider, url) === 'local';
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
 * The configured target moved (a settings save or removal): end every re-embed
 * job, so no batch an old generation scheduled writes into a space the
 * configuration has left. A staged rebuild keeps running; it targets its own
 * space, and activating it rewrites the configuration anyway.
 */
export async function endReembedJobs(ctx: MutationCtx): Promise<void> {
	await cancelJobs(ctx, (job) => job.kind !== 'reembed', Date.now());
}

/** The next column claim: higher than every claim so far. */
function nextClaim(spaces: readonly SpaceDoc[]): number {
	return spaces.reduce((max, space) => Math.max(max, space.columnClaim ?? 0), 0) + 1;
}

/**
 * The column a new tenant takes: the one `avoid` (the active space's) does not
 * use; with nothing to avoid, a column nobody owns, else the one whose owner
 * claimed it longest ago.
 */
function freeColumn(spaces: readonly SpaceDoc[], avoid: EmbeddingSlot | undefined): EmbeddingSlot {
	if (avoid) return otherSlot(avoid);
	const primary = columnOwnerOf(spaces, 'primary');
	const secondary = columnOwnerOf(spaces, 'secondary');
	if (!primary) return 'primary';
	if (!secondary) return 'secondary';
	return (primary.columnClaim ?? 0) <= (secondary.columnClaim ?? 0) ? 'primary' : 'secondary';
}

/**
 * Retire `space` under a superseded identity: its id (and every row stamped
 * with it) stays, but it can no longer be looked up, activated or reused.
 */
async function supersede(ctx: MutationCtx, space: SpaceDoc, now: number): Promise<void> {
	await ctx.db.patch(space._id, {
		identityKey: `${space.identityKey}#superseded:${space._id}`,
		state: 'retired',
		retiredAt: space.retiredAt ?? now,
		updatedAt: now,
	});
}

/**
 * Give a space a column, as `state`:
 *   - `existing` that still owns `slot` (or `slot` is unset and it owns its own):
 *     reused, with a fresh claim, its stored vectors intact;
 *   - `existing` that does not: superseded, and a fresh row with its identity
 *     takes the column;
 *   - `identity`: a new row takes the column.
 * Returns the row now holding the column.
 */
export async function claimColumn(
	ctx: MutationCtx,
	space:
		| { existing: SpaceDoc }
		| { identity: EmbeddingSpaceIdentity; source: SpaceDoc['source']; configVersion?: number },
	options: { slot: EmbeddingSlot; state: SpaceDoc['state']; extra?: Partial<SpaceDoc> }
): Promise<SpaceDoc> {
	const now = Date.now();
	const spaces = await readAllSpaces(ctx.db);
	const claim = nextClaim(spaces);
	if ('existing' in space) {
		const existing = space.existing;
		const isOwner = columnOwnerOf(spaces, existing.slot)?._id === existing._id;
		if (isOwner && existing.slot === options.slot) {
			await ctx.db.patch(existing._id, {
				state: options.state,
				columnClaim: claim,
				retiredAt: undefined,
				...options.extra,
				updatedAt: now,
			});
			return (await ctx.db.get(existing._id))!;
		}
		await supersede(ctx, existing, now);
	}
	const identity = 'existing' in space ? identityOf(space.existing) : space.identity;
	const source = 'existing' in space ? space.existing.source : space.source;
	const configVersion = 'existing' in space ? space.existing.configVersion : space.configVersion;
	const spaceId = await ctx.db.insert('embeddingSpaces', {
		...identity,
		identityKey: embeddingSpaceIdentityKey(identity),
		source,
		state: options.state,
		slot: options.slot,
		columnClaim: claim,
		...(configVersion !== undefined ? { configVersion } : {}),
		...options.extra,
		createdAt: now,
		updatedAt: now,
	});
	return (await ctx.db.get(spaceId))!;
}

/**
 * Make a space the active one, atomically: the previous active space is
 * retired, keeping its column, and recorded as the new space's
 * `predecessorSpaceId` (the rollback target); a staged rebuild for any other
 * space ends; jobs that target a space no longer active or staged are
 * cancelled. The incoming space reuses its stored vectors only while it still
 * owns their column and that column is not the outgoing space's; otherwise it
 * is superseded and takes the free column (`claimColumn`).
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
	const spaces = await readAllSpaces(ctx.db);
	const extra = {
		activatedAt: now,
		...(outgoing ? { predecessorSpaceId: outgoing._id } : {}),
	};
	let activated: SpaceDoc;
	if (existing) {
		const keepsColumn = existing.slot !== outgoing?.slot;
		activated = await claimColumn(
			ctx,
			{ existing },
			{
				slot: keepsColumn ? existing.slot : freeColumn(spaces, outgoing?.slot),
				state: 'active',
				extra,
			}
		);
	} else {
		const { source, ...identity } = (space as { identity: MeasuredSpace }).identity;
		activated = await claimColumn(
			ctx,
			{ identity, source, configVersion: (space as { configVersion?: number }).configVersion },
			{ slot: freeColumn(spaces, active?.slot), state: 'active', extra }
		);
	}
	await cancelJobs(
		ctx,
		(job) => job.targetSpaceId === activated._id && job.kind === 'reembed',
		now
	);
	// A local embedder re-embeds right away; a hosted one waits for an admin (D8).
	await ctx.scheduler.runAfter(0, internal.aiRouting.embeddingReembed.kickoff, { isForced: true });
	return activated;
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

/**
 * Record that an embedding input changed or a row was added: a staged rebuild
 * that started before now may have missed it, so its activation waits for a
 * catch-up pass (`embeddingRebuildState.activateStagedSpace`).
 */
export async function markCorpusChanged(ctx: MutationCtx): Promise<void> {
	const staged = await readStagedSpace(ctx.db);
	if (staged) await ctx.db.patch(staged._id, { inputChangedAt: Date.now() });
}

/**
 * After a mutation changed a row's embedding input without embedding it (an
 * edit): mark the change, and let a local embedder re-embed the row at once.
 * The caller has already cleared the row's columns (`inputChangeFields(null)`).
 */
export async function afterInputChange(
	ctx: MutationCtx,
	row:
		| { table: 'knowledgeEntries'; id: Id<'knowledgeEntries'> }
		| { table: 'semanticFiles'; id: Id<'semanticFiles'> }
): Promise<void> {
	await markCorpusChanged(ctx);
	await ctx.scheduler.runAfter(0, internal.aiRouting.embeddingReembed.reembedRow, {
		table: row.table,
		id: row.id,
	});
}

/**
 * THE vector-commit step. Every mutation that writes a freshly embedded vector
 * into the knowledge or file corpus passes the space the job measured and
 * writes the fields this returns. The vector lands in the active space's
 * column, stamped with its space and `measured` provenance and the model that
 * made it, and every other column is cleared (the input-change rule: the row
 * was just (re)processed). The corpus is marked changed for a staged rebuild.
 *
 * An empty vector clears every column. A vector without a measured space (a
 * previous-release job) or from a target the configuration no longer names is
 * dropped the same way: the row reads as not yet embedded, and the next pass or
 * the re-embed job embeds it in the current space.
 */
export async function vectorFieldsForCommit(
	ctx: MutationCtx,
	commit: { embedding: number[]; space: MeasuredSpace | undefined },
	options: { entryType?: EntryType }
): Promise<{ fields: Record<string, unknown>; isStale: boolean }> {
	const isKnowledge = options.entryType !== undefined;
	await markCorpusChanged(ctx);
	if (commit.embedding.length === 0) {
		return { fields: inputChangeFields(null, { isKnowledge }), isStale: false };
	}
	// Remove the optional space after release N+1 (CONVENTIONS "Old clients and workers").
	const space = commit.space ? await ensureConfiguredSpace(ctx, commit.space) : null;
	if (!space) return { fields: inputChangeFields(null, { isKnowledge }), isStale: true };
	return {
		fields: {
			...inputChangeFields(space.slot, { isKnowledge }),
			...slotFields(space, commit.embedding, { now: Date.now(), entryType: options.entryType }),
		},
		isStale: false,
	};
}
