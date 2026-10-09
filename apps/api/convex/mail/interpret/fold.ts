/**
 * The reducer's in-memory fold, pure (SPEC §4, review round 4 M1/M2): plans
 * from `reducePlan.ts` applied to a copy of the thread's items and facts;
 * `reduceWrite.ts` writes the difference.
 *
 * MONOTONE. Every extraction (a new message, a late one, a re-read or repair
 * of a source) is folded the same way, on top of what the thread holds:
 *
 *   - IDENTITY is the thread's. A claim resolves to an existing item by, in
 *     order, its explicit `matchItemId`, then a claim key that produced or
 *     matched the item before (`lineageKeys`), then nothing: a never-seen
 *     claim creates an item. A resolved claim MERGES (quotes, claim key)
 *     through the planner's guards: an unconfirmed claim on a tracked item
 *     waits as a pending update, a human or recorded status is never moved.
 *   - NOTHING IS RETIRED BY OMISSION. A re-read that no longer shows an item
 *     leaves it as it is; when the re-read message was that item's only
 *     source, the item is flagged for review ("the latest read of this
 *     message no longer shows it").
 *   - ORDER-AWARE TRANSITIONS replace the old rebuild: a status or
 *     disposition change from a message applies only when no transition from
 *     a newer message set the item's current state (`lastTransitionAt`);
 *     otherwise it is kept as evidence only. A late but verified "paid" with
 *     nothing newer still closes the invoice.
 */

import type { Doc, Id } from '../../_generated/dataModel';
import type { InterpretMode } from '@owlat/shared/threadBrief';
import {
	interpretationSourceKey,
	type Evidence,
	type InterpretationSource,
} from '../../lib/validators/threadBrief';
import {
	evidenceKey,
	planReduction,
	type EvidenceRef,
	type PlanFact,
	type PlanItem,
	type ReductionPlan,
} from './reducePlan';
import type { ReduceEvidence, ReduceFact, ReduceItem, ReduceResult } from './reduceInput';
import type { PlanHeld } from './reduceHeld';

/** Evidence in memory: stored (sealed quote) or new (plaintext quote, `isPlain`). */
export type MemEvidence = Evidence & { isPlain?: true };

export interface MemItem extends Omit<PlanItem, 'evidence'> {
	evidence: MemEvidence[];
	lineage?: string;
	/** Every claim key that produced or matched it (the thread's identity record). */
	lineageKeys?: string[];
	/** No row yet: the writer inserts it. */
	isNew: boolean;
	/**
	 * The claim whose text and parties the item takes: the one that created a
	 * new item, or the verified claim that promoted a proposal.
	 */
	proposal?: ReduceItem;
	/** The stored row's assertion and display (opened), to write only what changed. */
	storedAssertionText?: string;
	storedDisplay?: { en: string; de: string };
	askedAt: number;
	possibleDuplicateOfId?: Id<'threadItems'>;
	/** Changes held apart until confirmed (`reduceHeld.ts`); wording in plaintext. */
	pendingUpdate?: MemHeld;
	/** The stored held update's wording, opened (the writer compares against it). */
	storedPending?: { assertion?: string; display?: { en: string; de: string } };
}

export type MemHeld = Omit<PlanHeld, 'addEvidence'> & {
	evidence: MemEvidence[];
	transitions?: NonNullable<Doc<'threadItems'>['pendingUpdate']>['transitions'];
};

/** A held update merged onto the one already held: newer values win, removals stay unless re-set. */
export function mergeHeld(prior: MemHeld | undefined, next: MemHeld): MemHeld {
	const merged: MemHeld = {
		...prior,
		...next,
		evidence: [...(prior?.evidence ?? []), ...next.evidence],
	};
	for (const key of Object.keys(next) as Array<keyof MemHeld>) {
		if (next[key] === undefined && prior?.[key] !== undefined) {
			(merged as Record<string, unknown>)[key] = prior[key];
		}
	}
	const removes = [...new Set([...(prior?.removes ?? []), ...(next.removes ?? [])])].filter(
		(key) => next[key] === undefined
	);
	if (removes.length > 0) merged.removes = removes;
	else delete merged.removes;
	return merged;
}

export interface MemFact extends Omit<PlanFact, 'evidence'> {
	evidence: MemEvidence[];
	lineage?: string;
	/** Claim keys merged into it by this fold (kept in the source's claim record). */
	lineageKeys?: string[];
	isNew: boolean;
	/** The claim whose text and value the fact takes (new, or a same-source re-read). */
	proposal?: ReduceFact;
	storedAssertionText?: string;
	/** The stored row's display (opened) and value (exact comparable form). */
	storedDisplay?: { en: string; de: string };
	storedValueKey?: string;
	supersedesId?: Id<'threadFacts'>;
	conflictsWithId?: Id<'threadFacts'>;
}

export interface MemState {
	items: Map<string, MemItem>;
	facts: Map<string, MemFact>;
}

/** One extraction, as the fold takes it. */
export interface FoldEntry {
	source: InterpretationSource;
	sourceKey: string;
	contentRevision: string;
	/** The message's date: what order-aware transitions compare. */
	sourceAt: number;
	result: ReduceResult;
}

export interface MemOptions {
	mode: InterpretMode;
	threadKind: 'mail' | 'team';
	/** Older than the checkpoint: it may not retire a fact. */
	isOutOfOrder: boolean;
}

/** cyrb53: a fast, stable 53-bit string hash (identity keys, not security). */
function hash53(text: string): string {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < text.length; i++) {
		const ch = text.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function words(text: string): string {
	return text
		.normalize('NFKC')
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim();
}

function spans(evidence: readonly ReduceEvidence[]): string {
	return evidence
		.map((e) => `${e.segmentId}:${e.start}:${e.end}`)
		.sort()
		.join(',');
}

/** A claim's content key within its source message: intent, wording, quoted spans. Pure. */
export function itemLineage(
	sourceKey: string,
	item: Pick<ReduceItem, 'intent' | 'assertion' | 'evidence'>
): string {
	return `${sourceKey}#${hash53(`${item.intent}|${words(item.assertion)}|${spans(item.evidence)}`)}`;
}

/** A fact claim's content key within its source message. Pure. */
export function factLineage(
	sourceKey: string,
	fact: Pick<ReduceFact, 'key' | 'assertion' | 'evidence'>
): string {
	return `${sourceKey}#f${hash53(`${fact.key}|${words(fact.assertion)}|${spans(fact.evidence)}`)}`;
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
		...(e.occurrence !== undefined ? { occurrence: e.occurrence } : {}),
		...(e.occurrenceCount !== undefined ? { occurrenceCount: e.occurrenceCount } : {}),
		isPlain: true,
	}));
}

/**
 * Resolve each claim's identity against the thread (see the module doc): a
 * claim without a valid `matchItemId` whose content key produced (or matched)
 * an item before is pointed at that item, so it MERGES instead of creating a
 * twin. Terminal items count too (round 5 F4): a re-read of a request that was
 * replaced merges into it and never mints a new open item. Fact claims are
 * resolved the same way (returned as `factIdentity`, index → fact id).
 * `claimIds` is the source's stored lineage record (`interpretSources`), for
 * items outside the scanned state that the reducer loaded directly. Pure.
 */
export function resolveIdentity(
	state: MemState,
	result: ReduceResult,
	sourceKey: string,
	claimIds: ReadonlyMap<string, string> = new Map()
): { result: ReduceResult; factIdentity: Map<number, string> } {
	const byKey = new Map<string, string>(
		[...claimIds].filter(([, id]) => state.items.has(id) || state.facts.has(id))
	);
	for (const item of state.items.values()) {
		for (const key of [item.lineage, ...(item.lineageKeys ?? [])]) {
			if (key && !byKey.has(key)) byKey.set(key, item._id);
		}
	}
	for (const fact of state.facts.values()) {
		for (const key of [fact.lineage, ...(fact.lineageKeys ?? [])]) {
			if (key && !byKey.has(key)) byKey.set(key, fact._id);
		}
	}
	const items = result.items.map((claim) => {
		if (claim.matchItemId && state.items.has(claim.matchItemId)) return claim;
		const known = byKey.get(itemLineage(sourceKey, claim));
		return known && state.items.has(known) ? { ...claim, matchItemId: known } : claim;
	});
	const factIdentity = new Map<number, string>();
	for (const [index, fact] of (result.facts ?? []).entries()) {
		const known = byKey.get(factLineage(sourceKey, fact));
		if (known && state.facts.has(known)) factIdentity.set(index, known);
	}
	return { result: { ...result, items }, factIdentity };
}

/** Apply one plan to the state (mutates it). Pure apart from `state`. */
export function applyPlan(
	state: MemState,
	plan: ReductionPlan,
	entry: Pick<FoldEntry, 'source' | 'sourceKey' | 'contentRevision' | 'sourceAt'> & {
		result?: Pick<ReduceResult, 'facts'>;
	}
): Set<string> {
	const touched = new Set<string>();
	const ev = (list: readonly ReduceEvidence[]) =>
		plainEvidence(list, entry.source, entry.contentRevision);
	for (const insert of plan.inserts) {
		const p = insert.item;
		const lineage = itemLineage(entry.sourceKey, p);
		let id = `new:${lineage}`;
		for (let n = 1; state.items.has(id); n++) id = `new:${lineage}.${n}`;
		const item: MemItem = {
			_id: id as Id<'threadItems'>,
			lineage,
			lineageKeys: [lineage],
			isNew: true,
			proposal: p,
			status: 'open',
			disposition: 'unanswered',
			intent: p.intent,
			revision: 0,
			evidence: ev(p.evidence),
			verify: p.verify,
			...(p.due ? { due: p.due } : {}),
			...(p.amount ? { amount: p.amount } : {}),
			...(p.options ? { options: p.options } : {}),
			isReviewNeeded: p.isReviewNeeded,
			assertionText: p.assertion,
			askedAt: entry.sourceAt,
			...(insert.possibleDuplicateOfId
				? { possibleDuplicateOfId: insert.possibleDuplicateOfId }
				: {}),
		};
		state.items.set(item._id, item);
		touched.add(item._id);
	}
	for (const patch of plan.patches) {
		const item = state.items.get(patch.itemId);
		if (!item) continue;
		touched.add(item._id);
		if (patch.status !== undefined) {
			item.status = patch.status;
			item.completion = patch.completion;
		}
		if (patch.disposition !== undefined) item.disposition = patch.disposition;
		if (patch.lastTransitionAt !== undefined) item.lastTransitionAt = patch.lastTransitionAt;
		if (patch.statusSource) item.statusSource = patch.statusSource;
		if (patch.dispositionSource) item.dispositionSource = patch.dispositionSource;
		if (patch.addEvidence?.length) item.evidence = [...item.evidence, ...ev(patch.addEvidence)];
		if (patch.fill?.due) item.due = patch.fill.due;
		if (patch.fill?.amount) item.amount = patch.fill.amount;
		if (patch.fill?.options) item.options = patch.fill.options;
		if (patch.verify) item.verify = patch.verify;
		if (patch.isReviewNeeded) item.isReviewNeeded = true;
		if (patch.promoteFrom) {
			// The verified claim's own fields replace the proposal's (round 4 M3).
			const claim = patch.promoteFrom;
			item.proposal = claim;
			item.intent = claim.intent;
			item.due = claim.due;
			item.amount = claim.amount;
			item.options = claim.options;
			item.assertionText = claim.assertion;
		}
		if (patch.matched?.length) {
			item.lineageKeys = [
				...new Set([
					...(item.lineageKeys ?? []),
					...patch.matched.map((m) => itemLineage(entry.sourceKey, m)),
				]),
			];
		}
		if (patch.pendingUpdate) {
			const { addEvidence, ...changes } = patch.pendingUpdate;
			item.pendingUpdate = mergeHeld(item.pendingUpdate, { ...changes, evidence: ev(addEvidence) });
		}
	}
	const noteFactKey = (fact: MemFact, index: number) => {
		const claim = entry.result?.facts?.[index];
		if (!claim) return;
		fact.lineageKeys = [
			...new Set([...(fact.lineageKeys ?? []), factLineage(entry.sourceKey, claim)]),
		];
	};
	for (const op of plan.facts) {
		if (op.kind === 'supersede') {
			const fact = state.facts.get(op.factId);
			if (fact) fact.status = 'superseded';
		} else if (op.kind === 'evidence') {
			const fact = state.facts.get(op.factId);
			if (!fact) continue;
			fact.evidence = [...fact.evidence, ...ev(op.addEvidence)];
			noteFactKey(fact, op.index);
		} else if (op.kind === 'replace') {
			// A re-read of the fact's own (only) source message: it takes the new claim.
			const fact = state.facts.get(op.factId);
			if (!fact) continue;
			fact.proposal = op.fact;
			fact.factKey = op.fact.key;
			fact.assertionText = op.fact.assertion;
			fact.evidence = [...fact.evidence, ...ev(op.fact.evidence)];
			noteFactKey(fact, op.index);
		} else {
			const lineage = factLineage(entry.sourceKey, op.fact);
			let id = `new:${lineage}`;
			for (let n = 1; state.facts.has(id); n++) id = `new:${lineage}.${n}`;
			const f = op.fact;
			const fact: MemFact = {
				_id: id as Id<'threadFacts'>,
				lineage,
				isNew: true,
				proposal: f,
				factKey: f.key,
				status: 'current',
				revision: 0,
				...(f.value ? { value: f.value as Doc<'threadFacts'>['value'] } : {}),
				...(f.value && 'text' in f.value ? { valueText: f.value.text } : {}),
				assertionText: f.assertion,
				evidence: ev(f.evidence),
				...(op.supersedesId ? { supersedesId: op.supersedesId } : {}),
				...(op.conflictsWithId ? { conflictsWithId: op.conflictsWithId } : {}),
			};
			state.facts.set(fact._id, fact);
		}
	}
	return touched;
}

/**
 * A re-read that no longer shows an item never retires it (round 4 M1): an
 * item this source produced, untouched by the re-read, whose every quote
 * comes from this source, is flagged for review. Status, completion and
 * every human field stay as they are. Mutates `state`.
 */
export function flagUnreproduced(
	state: MemState,
	sourceKey: string,
	touched: ReadonlySet<string>
): void {
	const prefix = `${sourceKey}#`;
	for (const item of state.items.values()) {
		if (touched.has(item._id) || item.status === 'superseded') continue;
		const keys = [item.lineage, ...(item.lineageKeys ?? [])];
		if (!keys.some((k) => k?.startsWith(prefix))) continue;
		const isSolelyHere =
			item.evidence.length > 0 &&
			item.evidence.every((e) => interpretationSourceKey(e.source) === sourceKey);
		if (isSolelyHere) item.isReviewNeeded = true;
	}
}

/** Resolve identity, plan and apply one extraction. Returns the plan and the items it touched. */
export function foldEntry(
	state: MemState,
	entry: FoldEntry,
	opts: MemOptions,
	claimIds?: ReadonlyMap<string, string>
): { plan: ReductionPlan; touched: Set<string> } {
	const { result, factIdentity } = resolveIdentity(state, entry.result, entry.sourceKey, claimIds);
	const plan = planReduction(
		{ items: [...state.items.values()], facts: [...state.facts.values()] },
		result,
		entry.contentRevision,
		{ ...opts, source: entry.source, sourceAt: entry.sourceAt, factIdentity }
	);
	const touched = applyPlan(state, plan, entry);
	return { plan, touched };
}

/** Same evidence set (identity, quotes aside)? Pure. */
export function sameEvidence(a: readonly EvidenceRef[], b: readonly EvidenceRef[]): boolean {
	if (a.length !== b.length) return false;
	const set = new Set(a.map(evidenceKey));
	return b.every((e) => set.has(evidenceKey(e)));
}

/** Every claim key of `sourceKey` held by the folded state, with its (in-memory) id. Pure. */
export function claimKeysOf(state: MemState, sourceKey: string): Map<string, string> {
	const prefix = `${sourceKey}#`;
	const keys = new Map<string, string>();
	for (const item of state.items.values()) {
		for (const key of [item.lineage, ...(item.lineageKeys ?? [])]) {
			if (key?.startsWith(prefix)) keys.set(key, item._id);
		}
	}
	for (const fact of state.facts.values()) {
		for (const key of [fact.lineage, ...(fact.lineageKeys ?? [])]) {
			if (key?.startsWith(prefix)) keys.set(key, fact._id);
		}
	}
	return keys;
}
