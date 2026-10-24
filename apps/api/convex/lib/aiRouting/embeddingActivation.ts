/**
 * The writes of embedding provenance: activating a space, claiming
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
import type { Doc } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import type { Infer } from 'convex/values';
import type { entryTypeValidator } from '../../schema/knowledge';
import { resolveEndpointLocality } from '../llm/endpointLocality';
import { embeddingSpaceIdentityKey, type EmbeddingSpaceIdentity } from './embeddingKeys';
import { corpusRowInput, embeddingInputText, type CorpusTable } from './embeddingInputs';
import {
	identityOf,
	inputChangeFields,
	isIdentityOfTarget,
	otherSlot,
	readActiveSpace,
	readColumnOwner,
	readConfiguredTarget,
	readSpaceByIdentity,
	readStagedSpace,
	slotFields,
	vectorInSpace,
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

/** Each column's owner: the space there with the highest claim. */
type ColumnOwners = Record<EmbeddingSlot, SpaceDoc | null>;

async function readColumnOwners(db: MutationCtx['db']): Promise<ColumnOwners> {
	return {
		primary: await readColumnOwner(db, 'primary'),
		secondary: await readColumnOwner(db, 'secondary'),
	};
}

/**
 * The next column claim: higher than every claim so far. Every space has a
 * column, and each column's owner holds that column's highest claim.
 */
function nextClaim(owners: ColumnOwners): number {
	return Math.max(owners.primary?.columnClaim ?? 0, owners.secondary?.columnClaim ?? 0) + 1;
}

/**
 * The column a new tenant takes: the one `avoid` (the active space's) does not
 * use; with nothing to avoid, a column nobody owns, else the one whose owner
 * claimed it longest ago.
 */
function freeColumn(owners: ColumnOwners, avoid: EmbeddingSlot | undefined): EmbeddingSlot {
	if (avoid) return otherSlot(avoid);
	const { primary, secondary } = owners;
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
	const owners = await readColumnOwners(ctx.db);
	const claim = nextClaim(owners);
	if ('existing' in space) {
		const existing = space.existing;
		const isOwner = owners[existing.slot]?._id === existing._id;
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
	const owners = await readColumnOwners(ctx.db);
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
				slot: keepsColumn ? existing.slot : freeColumn(owners, outgoing?.slot),
				state: 'active',
				extra,
			}
		);
	} else {
		const { source, ...identity } = (space as { identity: MeasuredSpace }).identity;
		activated = await claimColumn(
			ctx,
			{ identity, source, configVersion: (space as { configVersion?: number }).configVersion },
			{ slot: freeColumn(owners, active?.slot), state: 'active', extra }
		);
	}
	await cancelJobs(
		ctx,
		(job) => job.targetSpaceId === activated._id && job.kind === 'reembed',
		now
	);
	// A local embedder re-embeds right away; a hosted one waits for an admin.
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
 * when the configuration names it (the embedding switch path). Null when the job's
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
 * Record that a staged rebuild may have missed a row: its activation waits for
 * a pass that starts after now (`embeddingRebuildState.activateStagedSpace`).
 */
export async function markCorpusChanged(ctx: MutationCtx): Promise<void> {
	const staged = await readStagedSpace(ctx.db);
	if (staged) await ctx.db.patch(staged._id, { inputChangedAt: Date.now() });
}

type CorpusRow = Doc<'knowledgeEntries'> | Doc<'semanticFiles'>;

/**
 * Mark a staged rebuild when a write left a row eligible for vector search but
 * without a staged vector in a way the rebuild's walk cannot have accounted
 * for: the row is new, it just became eligible (an expired entry revived, a
 * file processed), it lost its staged vector (an input change, a revoked
 * stamp), or its input changed. A row that was eligible and unembedded before
 * is still the walk's to embed.
 */
async function noteCorpusWrite(
	ctx: MutationCtx,
	table: CorpusTable,
	before: CorpusRow | null,
	next: CorpusRow,
	isInputChanged: boolean
): Promise<void> {
	const staged = await readStagedSpace(ctx.db);
	if (!staged) return;
	const now = Date.now();
	const ref = { spaceId: staged._id, slot: staged.slot };
	if (corpusRowInput(table, next, now) === null || vectorInSpace(next, ref)) return;
	const wasEligible = before !== null && corpusRowInput(table, before, now) !== null;
	const hadStaged = before !== null && vectorInSpace(before, ref) !== null;
	if (!wasEligible || hadStaged || isInputChanged) await markCorpusChanged(ctx);
}

async function scheduleRowReembed(
	ctx: MutationCtx,
	table: CorpusTable,
	id: CorpusRow['_id']
): Promise<void> {
	await ctx.scheduler.runAfter(0, internal.aiRouting.embeddingReembed.reembedRow, {
		table,
		id,
	});
}

/**
 * THE writer of a corpus row's embedding-relevant fields: its input (title,
 * content, summary, extracted text), its eligibility (expiry, processing) and
 * its vector stamps. Every such write goes through here, so none can forget:
 *
 *   - the input-change rule: a changed input clears every column except
 *     `written` (the column this write fills with a fresh vector);
 *   - a staged rebuild is marked changed when the write leaves the row
 *     eligible without a staged vector in a way its walk cannot have seen;
 *   - a row that became eligible, or whose input changed, with no fresh vector
 *     in this write is re-embedded at once by a local embedder.
 */
export async function patchCorpusRow(
	ctx: MutationCtx,
	table: CorpusTable,
	row: CorpusRow,
	patch: Record<string, unknown>,
	options: { written?: EmbeddingSlot | null } = {}
): Promise<void> {
	const now = Date.now();
	const draft = { ...row, ...patch } as CorpusRow;
	const isInputChanged = embeddingInputText(table, row) !== embeddingInputText(table, draft);
	const isKnowledge = table === 'knowledgeEntries';
	const fields = isInputChanged
		? { ...inputChangeFields(options.written ?? null, { isKnowledge }), ...patch }
		: patch;
	await ctx.db.patch(row._id, fields);
	const next = { ...row, ...fields } as CorpusRow;
	await noteCorpusWrite(ctx, table, row, next, isInputChanged);
	const wasEligible = corpusRowInput(table, row, now) !== null;
	const isEligible = corpusRowInput(table, next, now) !== null;
	if (!options.written && isEligible && (isInputChanged || !wasEligible)) {
		await scheduleRowReembed(ctx, table, row._id);
	}
}

/**
 * After a corpus row was inserted: mark a staged rebuild when the new row is
 * eligible without a staged vector, and let a local embedder embed a row that
 * arrived without a vector.
 */
export async function noteCorpusInsert(
	ctx: MutationCtx,
	table: CorpusTable,
	id: CorpusRow['_id']
): Promise<void> {
	const row = (await ctx.db.get(id)) as CorpusRow | null;
	if (!row) return;
	await noteCorpusWrite(ctx, table, null, row, true);
	const hasVector = row.embedding.length > 0 || (row.secondaryEmbedding?.length ?? 0) > 0;
	if (!hasVector && corpusRowInput(table, row, Date.now()) !== null) {
		await scheduleRowReembed(ctx, table, id);
	}
}

/**
 * THE vector-commit step. Every mutation that writes a freshly embedded vector
 * into the knowledge or file corpus passes the space the job measured and
 * writes the fields this returns. The vector lands in the active space's
 * column, stamped with its space and `measured` provenance and the model that
 * made it, and every other column is cleared (the input-change rule: the row
 * was just (re)processed). The caller writes the fields through
 * `patchCorpusRow` (with `written`), or inserts them and calls
 * `noteCorpusInsert`.
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
): Promise<{ fields: Record<string, unknown>; isStale: boolean; written: EmbeddingSlot | null }> {
	const isKnowledge = options.entryType !== undefined;
	if (commit.embedding.length === 0) {
		return { fields: inputChangeFields(null, { isKnowledge }), isStale: false, written: null };
	}
	// Remove the optional space after release N+1 (CONVENTIONS "Old clients and workers").
	const space = commit.space ? await ensureConfiguredSpace(ctx, commit.space) : null;
	if (!space) {
		return { fields: inputChangeFields(null, { isKnowledge }), isStale: true, written: null };
	}
	return {
		fields: {
			...inputChangeFields(space.slot, { isKnowledge }),
			...slotFields(space, commit.embedding, { now: Date.now(), entryType: options.entryType }),
		},
		isStale: false,
		written: space.slot,
	};
}
