/**
 * The reducer's in-memory state and the ordered replay (SPEC §4, review F5),
 * pure: plans from `reducePlan.ts` are applied to a copy of the thread's items
 * and facts, and `reduceWrite.ts` writes the difference.
 *
 *   - INCREMENTAL: the thread's current items and facts, plus one message.
 *   - REPLAY: when a message arrives out of order, or a message's extraction
 *     is replaced (a repair, an edited body), the thread is rebuilt from every
 *     stored extraction in message order. Items and facts keep their ids
 *     through their lineage (`<sourceKey>#<index>` / `#f<index>`): the row a
 *     proposal created is the row its replay updates. Human corrections and
 *     recorded operations (`threadActivity` rows with provenance `recorded` or
 *     `asserted` and a status or disposition delta) are re-applied on top, so
 *     a replay never undoes what a person or a send did.
 */

import type { Doc, Id } from '../../_generated/dataModel';
import type { InterpretMode, ItemStatus } from '@owlat/shared/threadBrief';
import type { Evidence, InterpretationSource } from '../../lib/validators/threadBrief';
import {
	evidenceKey,
	planReduction,
	type EvidenceRef,
	type PlanFact,
	type PlanItem,
	type ReductionPlan,
} from './reducePlan';
import type { ReduceEvidence, ReduceFact, ReduceItem, ReduceResult } from './reduceInput';

/** Evidence in memory: stored (sealed quote) or new (plaintext quote, `isPlain`). */
export type MemEvidence = Evidence & { isPlain?: true };

export interface MemItem extends Omit<PlanItem, 'evidence'> {
	evidence: MemEvidence[];
	lineage?: string;
	/** No row yet: the writer inserts it. */
	isNew: boolean;
	/** The proposal that created it (replay, or a new item): its text and parties. */
	proposal?: ReduceItem;
	/** A replayed row's stored assertion (opened), to tell whether its text changed. */
	storedAssertionText?: string;
	askedAt: number;
	possibleDuplicateOfId?: Id<'threadItems'>;
}

export interface MemFact extends Omit<PlanFact, 'evidence'> {
	evidence: MemEvidence[];
	lineage?: string;
	isNew: boolean;
	proposal?: ReduceFact;
	storedAssertionText?: string;
	supersedesId?: Id<'threadFacts'>;
	conflictsWithId?: Id<'threadFacts'>;
}

export interface MemState {
	items: Map<string, MemItem>;
	facts: Map<string, MemFact>;
}

/** One stored extraction, as a replay folds it in. */
export interface ReplayEntry {
	source: InterpretationSource;
	sourceKey: string;
	contentRevision: string;
	sourceAt: number;
	/** Tie-break for equal message dates. */
	appliedAt: number;
	result: ReduceResult;
}

export interface MemOptions {
	mode: InterpretMode;
	threadKind: 'mail' | 'team';
	isOutOfOrder: boolean;
}

/** Existing rows by lineage, so a replayed proposal maps onto its row. */
export interface LineageSeed {
	items: ReadonlyMap<string, MemItem>;
	facts: ReadonlyMap<string, MemFact>;
}

export function itemLineage(sourceKey: string, index: number): string {
	return `${sourceKey}#${index}`;
}
export function factLineage(sourceKey: string, index: number): string {
	return `${sourceKey}#f${index}`;
}

function plainEvidence(
	evidence: readonly ReduceEvidence[],
	source: InterpretationSource,
	contentRevision: string
): MemEvidence[] {
	return evidence.map((e) => ({
		source,
		contentRevision,
		segmentId: e.segmentId,
		start: e.start,
		end: e.end,
		quote: e.quote,
		isPlain: true,
	}));
}

/** Apply one plan to the state (mutates it). Pure apart from `state`. */
export function applyPlan(
	state: MemState,
	plan: ReductionPlan,
	entry: Pick<ReplayEntry, 'source' | 'sourceKey' | 'contentRevision' | 'sourceAt'>,
	seed?: LineageSeed
): void {
	const ev = (list: readonly ReduceEvidence[]) =>
		plainEvidence(list, entry.source, entry.contentRevision);
	for (const insert of plan.inserts) {
		const lineage = itemLineage(entry.sourceKey, insert.index);
		const row = seed?.items.get(lineage);
		const p = insert.item;
		const item: MemItem = {
			_id: (row?._id ?? `new:${lineage}`) as Id<'threadItems'>,
			lineage,
			isNew: !row,
			proposal: p,
			status: 'open',
			disposition: 'unanswered',
			intent: p.intent,
			revision: row?.revision ?? 0,
			evidence: ev(p.evidence),
			...(row?.correction ? { correction: row.correction } : {}),
			verify: p.verify,
			...(p.due ? { due: p.due } : {}),
			...(p.amount ? { amount: p.amount } : {}),
			...(p.options ? { options: p.options } : {}),
			isReviewNeeded: p.isReviewNeeded,
			assertionText: p.assertion,
			...(row ? { storedAssertionText: row.assertionText } : {}),
			askedAt: entry.sourceAt,
			...(insert.possibleDuplicateOfId
				? { possibleDuplicateOfId: insert.possibleDuplicateOfId }
				: {}),
		};
		state.items.set(item._id, item);
	}
	for (const patch of plan.patches) {
		const item = state.items.get(patch.itemId);
		if (!item) continue;
		if (patch.status !== undefined) {
			item.status = patch.status;
			item.completion = patch.completion;
		}
		if (patch.disposition !== undefined) item.disposition = patch.disposition;
		if (patch.addEvidence?.length) item.evidence = [...item.evidence, ...ev(patch.addEvidence)];
		if (patch.fill?.due) item.due = patch.fill.due;
		if (patch.fill?.amount) item.amount = patch.fill.amount;
		if (patch.fill?.options) item.options = patch.fill.options;
		if (patch.verify) item.verify = patch.verify;
		if (patch.isReviewNeeded) item.isReviewNeeded = true;
	}
	for (const op of plan.facts) {
		if (op.kind === 'supersede') {
			const fact = state.facts.get(op.factId);
			if (fact) fact.status = 'superseded';
		} else if (op.kind === 'evidence') {
			const fact = state.facts.get(op.factId);
			if (fact) fact.evidence = [...fact.evidence, ...ev(op.addEvidence)];
		} else {
			const lineage = factLineage(entry.sourceKey, op.index);
			const row = seed?.facts.get(lineage);
			const f = op.fact;
			const fact: MemFact = {
				_id: (row?._id ?? `new:${lineage}`) as Id<'threadFacts'>,
				lineage,
				isNew: !row,
				proposal: f,
				factKey: f.key,
				status: 'current',
				revision: row?.revision ?? 0,
				...(f.value ? { value: f.value as Doc<'threadFacts'>['value'] } : {}),
				...(f.value && 'text' in f.value ? { valueText: f.value.text } : {}),
				assertionText: f.assertion,
				...(row ? { storedAssertionText: row.assertionText } : {}),
				evidence: ev(f.evidence),
				...(op.supersedesId ? { supersedesId: op.supersedesId } : {}),
				...(op.conflictsWithId ? { conflictsWithId: op.conflictsWithId } : {}),
			};
			state.facts.set(fact._id, fact);
		}
	}
}

/** Plan and apply one message on the state. Returns the plan (for its drop list). */
export function foldEntry(
	state: MemState,
	entry: Pick<ReplayEntry, 'source' | 'sourceKey' | 'contentRevision' | 'sourceAt' | 'result'>,
	opts: MemOptions,
	seed?: LineageSeed
): ReductionPlan {
	const plan = planReduction(
		{ items: [...state.items.values()], facts: [...state.facts.values()] },
		entry.result,
		entry.contentRevision,
		{ ...opts, source: entry.source }
	);
	applyPlan(state, plan, entry, seed);
	return plan;
}

/** Message order: date, then when it was applied, then source key. Pure. */
export function replayOrder(entries: readonly ReplayEntry[]): ReplayEntry[] {
	return [...entries].sort(
		(a, b) =>
			a.sourceAt - b.sourceAt ||
			a.appliedAt - b.appliedAt ||
			(a.sourceKey < b.sourceKey ? -1 : a.sourceKey > b.sourceKey ? 1 : 0)
	);
}

/**
 * Rebuild the derived state from the stored extractions in message order.
 * `base` holds items and facts that no extraction created (no lineage); they
 * stay as they are. Pure.
 */
export function replayThread(
	entries: readonly ReplayEntry[],
	base: MemState,
	seed: LineageSeed,
	opts: Omit<MemOptions, 'isOutOfOrder'>
): MemState {
	const state: MemState = { items: new Map(base.items), facts: new Map(base.facts) };
	for (const entry of replayOrder(entries)) {
		foldEntry(state, entry, { ...opts, isOutOfOrder: false }, seed);
	}
	return state;
}

/** One human or recorded change to re-apply after a replay (from threadActivity). */
export interface HumanOp {
	itemId: string;
	statusTo?: ItemStatus;
	dispositionTo?: Doc<'threadItems'>['disposition'];
	completion?: Doc<'threadItems'>['completion'];
}

const CORRECTION_STATUS: Partial<Record<string, ItemStatus>> = {
	markedDone: 'done',
	untracked: 'untracked',
	notARequest: 'untracked',
	reopened: 'open',
};

/**
 * Re-apply recorded and asserted changes in their order, then make sure every
 * human correction still holds (mutates `state`). Pure apart from `state`.
 */
export function applyHumanOps(state: MemState, ops: readonly HumanOp[]): void {
	for (const op of ops) {
		const item = state.items.get(op.itemId);
		if (!item) continue;
		if (op.statusTo) {
			item.status = op.statusTo;
			item.completion = op.statusTo === 'done' ? (op.completion ?? item.completion) : undefined;
		}
		if (op.dispositionTo) item.disposition = op.dispositionTo;
	}
	for (const item of state.items.values()) {
		const kind = item.correction?.kind;
		if (!kind) continue;
		if (kind === 'confirmed') {
			item.verify = 'passed';
			continue;
		}
		const status = CORRECTION_STATUS[kind];
		if (status && item.status !== status) {
			item.status = status;
			item.completion = status === 'done' ? 'asserted' : undefined;
		}
	}
}

/** Same evidence set (identity, quotes aside)? Pure. */
export function sameEvidence(a: readonly EvidenceRef[], b: readonly EvidenceRef[]): boolean {
	if (a.length !== b.length) return false;
	const set = new Set(a.map(evidenceKey));
	return b.every((e) => set.has(evidenceKey(e)));
}
