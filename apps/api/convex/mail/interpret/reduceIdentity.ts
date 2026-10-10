/**
 * Identity beyond the fold's bounded scan (review rounds 5 F5, 6 F2), for
 * `reduce.ts`.
 *
 *   - THE CLAIM RECORD. Each source's `interpretSources` row keeps
 *     `claimIds`: claim key → the item or fact that claim produced or merged
 *     into. Before folding, the claim keys of the INCOMING result are looked
 *     up in it, and exactly those rows are loaded by id, with every explicit
 *     target the model named (`matchItemId`, a transition's `itemId`, a
 *     fact's `matchFactId` / `supersedes` / `conflictsWith`), each checked to
 *     belong to the same thread. No budget: the loads are bounded by the
 *     result's own size, so identity never depends on the scan reaching a row.
 *     On a re-read, every item the record names is loaded too (the re-read
 *     flags what it no longer shows, `fold.ts flagUnreproduced`).
 *   - The record is MERGE-UPDATED after the fold: mappings the fold did not
 *     touch stay as they are; it never drops one (an entry whose row is gone
 *     resolves to nothing). It is bounded only by Convex's array limit
 *     ({@link MAX_CLAIM_IDS}); past it the row is marked `isClaimRecordFull`
 *     and the outcome says so (the keys already recorded still resolve).
 *   - Pending transitions (a completion read before its request) live in
 *     `pendingMatch.ts`.
 */

import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import type { InterpretMode } from '@owlat/shared/threadBrief';
import { rowMatchesThreadRef, type ThreadRef } from '../../lib/validators/threadRef';
import { claimKeysOf, factLineage, itemLineage, type MemState } from './fold';
import { factToMem, itemToMem } from './reduceState';
import type { ReduceResult } from './reduceInput';
import { MAX_INTERPRET_TRANSITIONS } from './schema';

/** Convex's array limit is 8192; the record stays below it. */
export const MAX_CLAIM_IDS = 8000;
/** Pending transitions one extraction keeps: every one a result can carry. */
export const MAX_PENDING_PER_ROW = MAX_INTERPRET_TRANSITIONS;

export interface FoldRows {
	state: MemState;
	rows: Map<string, Doc<'threadItems'>>;
	factRows: Map<string, Doc<'threadFacts'>>;
}

type ClaimEntry = NonNullable<Doc<'interpretSources'>['claimIds']>[number];

/** The source's row and its claim record (claim key → item or fact id). */
export async function sourceClaimIds(
	ctx: MutationCtx,
	sourceKey: string
): Promise<{ sourceRow: Doc<'interpretSources'> | null; claimIds: Map<string, string> }> {
	const row = await ctx.db
		.query('interpretSources')
		.withIndex('by_source_key', (q) => q.eq('sourceKey', sourceKey))
		.first();
	const claimIds = new Map<string, string>();
	for (const entry of row?.claimIds ?? []) {
		const id = entry.itemId ?? entry.factId;
		if (id) claimIds.set(entry.key, id);
	}
	return { sourceRow: row, claimIds };
}

/**
 * Every row id the incoming result names, explicitly or through the claim
 * record (its claims' keys); on a re-read every item the record names. Pure.
 */
export function identityTargets(
	result: ReduceResult,
	sourceKey: string,
	claimIds: ReadonlyMap<string, string>,
	opts: { isReapply: boolean }
): string[] {
	const ids = new Set<string>();
	for (const item of result.items) {
		if (item.matchItemId) ids.add(item.matchItemId);
		const known = claimIds.get(itemLineage(sourceKey, item));
		if (known) ids.add(known);
	}
	for (const t of result.transitions) if (t.itemId) ids.add(t.itemId);
	for (const fact of result.facts ?? []) {
		for (const id of [fact.matchFactId, fact.supersedes, fact.conflictsWith]) {
			if (id) ids.add(id);
		}
		const known = claimIds.get(factLineage(sourceKey, fact));
		if (known) ids.add(known);
	}
	if (opts.isReapply) for (const id of claimIds.values()) ids.add(id);
	return [...ids];
}

/**
 * Load the named rows the scan did not reach into the fold's state, each only
 * when it belongs to this thread (an id from another thread is ignored).
 */
export async function loadIdentityTargets(
	ctx: MutationCtx,
	ref: ThreadRef,
	mode: InterpretMode,
	loaded: FoldRows,
	ids: readonly string[]
): Promise<void> {
	for (const id of ids) {
		if (loaded.state.items.has(id) || loaded.state.facts.has(id)) continue;
		const itemId = ctx.db.normalizeId('threadItems', id);
		if (itemId) {
			const row = await ctx.db.get(itemId);
			if (row && rowMatchesThreadRef(row, ref)) {
				loaded.rows.set(row._id, row);
				loaded.state.items.set(row._id, await itemToMem(row));
			}
			continue;
		}
		const factId = mode === 'brief' ? ctx.db.normalizeId('threadFacts', id) : null;
		if (!factId) continue;
		const row = await ctx.db.get(factId);
		if (row && rowMatchesThreadRef(row, ref)) {
			loaded.factRows.set(row._id, row);
			loaded.state.facts.set(row._id, await factToMem(row));
		}
	}
}

/**
 * Merge-update the source's claim record after a fold: every claim key of
 * this source the state holds, with its real id (`ids` maps inserted rows),
 * over the record as it was. Returns whether the record is full.
 */
export async function storeClaimIds(
	ctx: MutationCtx,
	sourceRow: Doc<'interpretSources'> | null,
	state: MemState,
	sourceKey: string,
	ids: ReadonlyMap<string, string>
): Promise<boolean> {
	if (!sourceRow) return false;
	const entries = new Map<string, ClaimEntry>(
		(sourceRow.claimIds ?? []).map((entry) => [entry.key, entry])
	);
	let isFull = sourceRow.isClaimRecordFull === true;
	for (const [key, memId] of claimKeysOf(state, sourceKey)) {
		const id = ids.get(memId) ?? (memId.startsWith('new:') ? undefined : memId);
		if (!id) continue;
		const entry: ClaimEntry = state.items.has(memId)
			? { key, itemId: id as Id<'threadItems'> }
			: { key, factId: id as Id<'threadFacts'> };
		if (!entries.has(key) && entries.size >= MAX_CLAIM_IDS) {
			isFull = true;
			continue;
		}
		entries.set(key, entry);
	}
	const next = [...entries.values()];
	const isChanged =
		JSON.stringify(sourceRow.claimIds ?? []) !== JSON.stringify(next) ||
		isFull !== (sourceRow.isClaimRecordFull === true);
	if (isChanged) {
		await ctx.db.patch(sourceRow._id, {
			claimIds: next,
			...(isFull ? { isClaimRecordFull: true } : {}),
			updatedAt: Date.now(),
		});
	}
	return isFull;
}

/** The pending transition indexes an extraction keeps. Pure. */
export function pendingFieldsOf(
	unresolved: readonly number[]
): Pick<Doc<'messageInterpretations'>, 'pendingTransitions' | 'isPendingTransitions'> {
	const kept = unresolved.slice(0, MAX_PENDING_PER_ROW);
	return kept.length > 0
		? { pendingTransitions: kept, isPendingTransitions: true }
		: { pendingTransitions: undefined, isPendingTransitions: undefined };
}
