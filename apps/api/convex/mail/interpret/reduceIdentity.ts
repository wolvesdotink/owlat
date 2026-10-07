/**
 * Identity beyond the fold's bounded scan, and claims waiting for their item
 * (review round 5 F5, F7), for `reduce.ts`:
 *
 *   - THE CLAIM RECORD. Each source's `interpretSources` row keeps
 *     `claimIds`: claim key → the item or fact that claim produced or merged
 *     into. The reducer loads those rows, and every explicit target the
 *     model named (`matchItemId`, a transition's `itemId`, a fact's
 *     `matchFactId` / `supersedes` / `conflictsWith`), directly by id,
 *     checked to belong to the same thread, so identity never depends on the
 *     scan reaching them. The record goes with the source row on erasure.
 *   - PENDING TRANSITIONS. A transition on an obligation not seen yet (a
 *     completion read before its delayed request, `itemId` absent and
 *     `about` set) is kept on its extraction row (`pendingTransitions`, its
 *     indexes). When a later fold creates items, the thread's pending rows are
 *     read and each pending transition that names one of the new items (by
 *     wording) is applied as its own message's transition, through the same
 *     planner and its order stamps. Bounded on both sides.
 */

import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import type { InterpretMode } from '@owlat/shared/threadBrief';
import { rowMatchesThreadRef, type ThreadRef } from '../../lib/validators/threadRef';
import { applyPlan, claimKeysOf, type MemOptions, type MemState } from './fold';
import { planReduction, textSimilarity } from './reducePlan';
import { factToMem, itemToMem } from './reduceState';
import { readResult } from './load';
import type { ReduceResult } from './reduceInput';

/** Claim keys one source keeps (newest last). */
export const MAX_CLAIM_IDS = 200;
/** Rows one fold loads by id beyond its scan. */
const MAX_DIRECT_LOADS = 100;
/** Pending transitions one extraction keeps. */
export const MAX_PENDING_PER_ROW = 10;
/** Extraction rows with pending transitions one fold reads. */
const PENDING_ROWS_SCAN = 20;
/** How close a pending transition's `about` must be to a new item's assertion. */
const PENDING_MATCH_MIN = 0.5;

export interface FoldRows {
	state: MemState;
	rows: Map<string, Doc<'threadItems'>>;
	factRows: Map<string, Doc<'threadFacts'>>;
}

/** The source's row and its claim record (claim key → item or fact id). */
export async function sourceClaimIds(
	ctx: MutationCtx,
	sourceKey: string
): Promise<{ sourceRowId?: Id<'interpretSources'>; claimIds: Map<string, string> }> {
	const row = await ctx.db
		.query('interpretSources')
		.withIndex('by_source_key', (q) => q.eq('sourceKey', sourceKey))
		.first();
	const claimIds = new Map<string, string>();
	for (const entry of row?.claimIds ?? []) {
		const id = entry.itemId ?? entry.factId;
		if (id) claimIds.set(entry.key, id);
	}
	return { ...(row ? { sourceRowId: row._id } : {}), claimIds };
}

/** Every row id the result or the claim record names. Pure. */
export function identityTargets(
	result: ReduceResult,
	claimIds: ReadonlyMap<string, string>
): string[] {
	const ids = new Set<string>();
	for (const item of result.items) if (item.matchItemId) ids.add(item.matchItemId);
	for (const t of result.transitions) if (t.itemId) ids.add(t.itemId);
	for (const fact of result.facts ?? []) {
		for (const id of [fact.matchFactId, fact.supersedes, fact.conflictsWith]) {
			if (id) ids.add(id);
		}
	}
	for (const id of claimIds.values()) ids.add(id);
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
	let budget = MAX_DIRECT_LOADS;
	for (const id of ids) {
		if (budget <= 0) return;
		if (loaded.state.items.has(id) || loaded.state.facts.has(id)) continue;
		const itemId = ctx.db.normalizeId('threadItems', id);
		if (itemId) {
			budget--;
			const row = await ctx.db.get(itemId);
			if (row && rowMatchesThreadRef(row, ref)) {
				loaded.rows.set(row._id, row);
				loaded.state.items.set(row._id, await itemToMem(row));
			}
			continue;
		}
		const factId = mode === 'brief' ? ctx.db.normalizeId('threadFacts', id) : null;
		if (factId) {
			budget--;
			const row = await ctx.db.get(factId);
			if (row && rowMatchesThreadRef(row, ref)) {
				loaded.factRows.set(row._id, row);
				loaded.state.facts.set(row._id, await factToMem(row));
			}
		}
	}
}

/**
 * Store the source's claim record after a fold: every claim key of this
 * source the state holds, with the real id (`ids` maps inserted rows).
 */
export async function storeClaimIds(
	ctx: MutationCtx,
	sourceRowId: Id<'interpretSources'> | undefined,
	state: MemState,
	sourceKey: string,
	ids: ReadonlyMap<string, string>
): Promise<void> {
	if (!sourceRowId) return;
	const entries: NonNullable<Doc<'interpretSources'>['claimIds']> = [];
	for (const [key, memId] of claimKeysOf(state, sourceKey)) {
		const id = ids.get(memId) ?? (memId.startsWith('new:') ? undefined : memId);
		if (!id) continue;
		entries.push(
			state.items.has(memId)
				? { key, itemId: id as Id<'threadItems'> }
				: { key, factId: id as Id<'threadFacts'> }
		);
	}
	const row = await ctx.db.get(sourceRowId);
	if (!row) return;
	const kept = entries.slice(-MAX_CLAIM_IDS);
	if (JSON.stringify(row.claimIds ?? []) === JSON.stringify(kept)) return;
	await ctx.db.patch(sourceRowId, { claimIds: kept, updatedAt: Date.now() });
}

/** The pending transition indexes an extraction keeps (bounded). Pure. */
export function pendingFieldsOf(
	unresolved: readonly number[]
): Pick<Doc<'messageInterpretations'>, 'pendingTransitions' | 'isPendingTransitions'> {
	const kept = unresolved.slice(0, MAX_PENDING_PER_ROW);
	return kept.length > 0
		? { pendingTransitions: kept, isPendingTransitions: true }
		: { pendingTransitions: undefined, isPendingTransitions: undefined };
}

async function pendingRowsOf(ctx: MutationCtx, ref: ThreadRef) {
	return ref.kind === 'mail'
		? ctx.db
				.query('messageInterpretations')
				.withIndex('by_mail_thread_pending', (q) =>
					q.eq('mailThreadId', ref.id).eq('isPendingTransitions', true)
				)
				.take(PENDING_ROWS_SCAN)
		: ctx.db
				.query('messageInterpretations')
				.withIndex('by_conversation_thread_pending', (q) =>
					q.eq('conversationThreadId', ref.id).eq('isPendingTransitions', true)
				)
				.take(PENDING_ROWS_SCAN);
}

/**
 * Apply the thread's pending transitions to the items this fold created
 * (mutates `state`). Returns, per pending row it settled, the indexes still
 * pending, for the caller to store once the state is written.
 */
export async function applyPendingTransitions(
	ctx: MutationCtx,
	ref: ThreadRef,
	state: MemState,
	opts: MemOptions,
	exceptSourceKey: string
): Promise<Array<{ rowId: Id<'messageInterpretations'>; remaining: number[] }>> {
	const created = [...state.items.values()].filter((item) => item.isNew);
	if (created.length === 0) return [];
	const settled: Array<{ rowId: Id<'messageInterpretations'>; remaining: number[] }> = [];
	for (const row of await pendingRowsOf(ctx, ref)) {
		if (row.sourceKey === exceptSourceKey || row.isCurrent === false) continue;
		const result = await readResult(row);
		if (!result) continue;
		const remaining: number[] = [];
		for (const index of row.pendingTransitions ?? []) {
			const t = result.transitions[index];
			if (!t?.about) continue;
			let best: { id: string; score: number } | null = null;
			for (const item of created) {
				const score = textSimilarity(t.about, item.assertionText);
				if (score >= PENDING_MATCH_MIN && (!best || score > best.score)) {
					best = { id: item._id, score };
				}
			}
			if (!best) {
				remaining.push(index);
				continue;
			}
			const sourceAt = row.sourceAt ?? row.createdAt;
			const plan = planReduction(
				{ items: [...state.items.values()], facts: [] },
				{ ...result, items: [], facts: [], transitions: [{ ...t, itemId: best.id }] },
				row.contentRevision,
				{ ...opts, source: row.source, sourceAt }
			);
			applyPlan(state, plan, {
				source: row.source,
				sourceKey: row.sourceKey,
				contentRevision: row.contentRevision,
				sourceAt,
			});
		}
		if (remaining.length !== (row.pendingTransitions ?? []).length) {
			settled.push({ rowId: row._id, remaining });
		}
	}
	return settled;
}
