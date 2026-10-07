/**
 * The reducer's decisions, pure (SPEC §4 `reduce.ts`): given the thread's
 * current items and facts and one message's grounded result, what changes.
 * `reduce.ts` loads the state, calls {@link planReduction}, and writes the
 * plan (sealing text) in one transaction.
 *
 * Rules:
 *   - ITEMS. A proposal whose `matchItemId` names an item of this thread adds
 *     its evidence to it (one item, more quotes). Otherwise it becomes a new
 *     item; when an open item of the same intent says nearly the same thing,
 *     the new one carries `possibleDuplicateOfId` (an ambiguous match never
 *     merges silently). A repeat of an item a human closed, or one that was
 *     reported done, sets `isReviewNeeded` instead of reopening it.
 *   - TRANSITIONS follow `isLegalStatusEdge` / `isLegalDispositionEdge`. A
 *     closing transition (done, declined, superseded) needs the verifier's
 *     confirmation; "done" from the model is stored as `completion:
 *     'reported'`. The model never untracks and never sets `failed` (the user
 *     and the send lifecycle do). A human correction is never flipped:
 *     conflicting evidence on a corrected item sets `isReviewNeeded`.
 *     An unsupported closing claim has NO effect at all (its disposition and
 *     quotes are dropped with it).
 *   - FACTS (brief mode, mail threads only). Only a proven restatement (the
 *     same structured value, or no value on either side and the same words)
 *     adds evidence; a verified supersession retires the old fact; anything
 *     else under the same key, an unverified supersession or an explicit
 *     contradiction is stored as a conflict beside the current fact.
 *   - EVIDENCE is deduplicated per source message, content revision and span,
 *     so the same words in two messages stay two references.
 *   - OUT OF ORDER. The reducer replays the thread in message order
 *     (`replay.ts`), so a late message is folded in where it belongs. Only
 *     when a replay is over budget does it fall back to `isOutOfOrder`: the
 *     late message then adds items, evidence and facts but moves no status.
 */

import type { Doc, Id } from '../../_generated/dataModel';
import type { ActivityType, ItemStatus } from '@owlat/shared/threadBrief';
import { isLegalDispositionEdge, isLegalStatusEdge } from '@owlat/shared/threadBriefRules';
import { normalizeEmail } from '@owlat/shared';
import {
	interpretationSourceKey,
	type InterpretationSource,
} from '../../lib/validators/threadBrief';
import type { ReduceEvidence, ReduceFact, ReduceItem, ReduceResult } from './reduceInput';

/** The identity of one piece of evidence (its quote aside). */
export interface EvidenceRef {
	source: InterpretationSource;
	contentRevision: string;
	segmentId: string;
	start: number;
	end: number;
}

/** The item fields the plan reads. */
export type PlanItem = Pick<
	Doc<'threadItems'>,
	| '_id'
	| 'status'
	| 'disposition'
	| 'intent'
	| 'revision'
	| 'correction'
	| 'verify'
	| 'due'
	| 'amount'
	| 'options'
	| 'completion'
	| 'isReviewNeeded'
> & {
	evidence: readonly EvidenceRef[];
	/** Unsealed assertion, for the duplicate check. */
	assertionText: string;
};

/** The fact fields the plan reads. */
export type PlanFact = Pick<Doc<'threadFacts'>, '_id' | 'factKey' | 'status' | 'revision' | 'value'> & {
	evidence: readonly EvidenceRef[];
	/** The value with its sealed text opened, for comparison. */
	valueText?: string;
	/** Unsealed assertion, for the restatement check. */
	assertionText: string;
};

export interface PlanOptions {
	mode: 'brief' | 'actions';
	threadKind: 'mail' | 'team';
	isOutOfOrder: boolean;
	/** The message being folded in (evidence identity). */
	source: InterpretationSource;
}

/** Evidence as the plan hands it to the writer (plaintext quote). */
export type PlanEvidence = ReduceEvidence;

export type ItemPatch = {
	itemId: Id<'threadItems'>;
	status?: ItemStatus;
	disposition?: Doc<'threadItems'>['disposition'];
	completion?: Doc<'threadItems'>['completion'];
	addEvidence?: PlanEvidence[];
	fill?: Partial<Pick<Doc<'threadItems'>, 'due' | 'amount' | 'options'>>;
	verify?: Doc<'threadItems'>['verify'];
	isReviewNeeded?: boolean;
	activity?: {
		type: ActivityType;
		delta?: {
			statusFrom?: ItemStatus;
			statusTo?: ItemStatus;
			dispositionFrom?: Doc<'threadItems'>['disposition'];
			dispositionTo?: Doc<'threadItems'>['disposition'];
			completion?: Doc<'threadItems'>['completion'];
		};
	};
};

export type FactOp =
	| {
			kind: 'insert';
			/** Index in the result's `facts` (the fact's lineage). */
			index: number;
			fact: ReduceFact;
			supersedesId?: Id<'threadFacts'>;
			conflictsWithId?: Id<'threadFacts'>;
	  }
	| { kind: 'evidence'; factId: Id<'threadFacts'>; addEvidence: PlanEvidence[] }
	| { kind: 'supersede'; factId: Id<'threadFacts'> };

export type DropReason =
	| 'unknown_item'
	| 'unverified'
	| 'illegal_edge'
	| 'corrected'
	| 'out_of_order'
	| 'model_forbidden'
	| 'no_change';

export interface ReductionPlan {
	/** `index`: the proposal's index in the result's `items` (the item's lineage). */
	inserts: Array<{ item: ReduceItem; index: number; possibleDuplicateOfId?: Id<'threadItems'> }>;
	patches: ItemPatch[];
	facts: FactOp[];
	dropped: Array<{ kind: 'transition' | 'fact'; index: number; reason: DropReason }>;
}

const CLOSING: ReadonlySet<ItemStatus> = new Set(['done', 'declined', 'superseded']);
/** Correction kinds that pin an item's status against later model evidence. */
const STATUS_LOCKING_CORRECTIONS: ReadonlySet<string> = new Set([
	'markedDone',
	'reopened',
	'untracked',
	'notARequest',
]);

/** Similarity above which a new item is marked a possible duplicate of an open one. */
export const DUPLICATE_SIMILARITY = 0.7;

function tokens(text: string): Set<string> {
	return new Set(
		text
			.normalize('NFKC')
			.toLowerCase()
			.split(/[^\p{L}\p{N}]+/u)
			.filter((t) => t.length > 2)
	);
}

/** Jaccard similarity of two sentences' word sets. Pure. */
export function textSimilarity(a: string, b: string): number {
	const ta = tokens(a);
	const tb = tokens(b);
	if (ta.size === 0 || tb.size === 0) return 0;
	let shared = 0;
	for (const t of ta) if (tb.has(t)) shared++;
	return shared / (ta.size + tb.size - shared);
}

/** The identity of a piece of evidence: source, content revision and span. Pure. */
export function evidenceKey(e: EvidenceRef): string {
	return `${interpretationSourceKey(e.source)}|${e.contentRevision}|${e.segmentId}:${e.start}:${e.end}`;
}

/** Evidence of `incoming` (from `source` at `contentRevision`) not already held. */
function newEvidence(
	existing: readonly EvidenceRef[],
	incoming: readonly PlanEvidence[],
	source: InterpretationSource,
	contentRevision: string
): PlanEvidence[] {
	const seen = new Set(existing.map(evidenceKey));
	return incoming.filter((e) => !seen.has(evidenceKey({ ...e, source, contentRevision })));
}

function isStatusLocked(item: PlanItem): boolean {
	return !!item.correction && STATUS_LOCKING_CORRECTIONS.has(item.correction.kind);
}

/** How an item proposal's responsible party reads as a responsibility. */
export function responsibilityOf(responsible: {
	email?: string;
	name?: string;
	isUs: boolean;
}): 'us' | 'them' | 'unclear' {
	if (responsible.isUs) return 'us';
	if (responsible.email || responsible.name) return 'them';
	return 'unclear';
}

/** The counterparty of an item (P4 cross-thread key): the other side's address. */
export function counterpartyKeyOf(
	item: Pick<ReduceItem, 'requester' | 'responsible'>
): string | undefined {
	const other = !item.requester.isUs
		? item.requester.email
		: !item.responsible.isUs
			? item.responsible.email
			: undefined;
	return other ? normalizeEmail(other) : undefined;
}

function factValueText(value: ReduceFact['value']): string | undefined {
	if (!value) return undefined;
	switch (value.kind) {
		case 'date':
			return `date:${value.at}`;
		case 'money':
			return `money:${value.value}:${value.currency.toUpperCase()}`;
		default:
			return `${value.kind}:${value.text.trim().toLowerCase()}`;
	}
}

/** The comparable form of a stored fact's value (`valueText` holds opened text). */
export function storedFactValueText(fact: PlanFact): string | undefined {
	const value = fact.value;
	if (!value) return undefined;
	if (value.kind === 'date') return `date:${value.at}`;
	if (value.kind === 'money') return `money:${value.value}:${value.currency.toUpperCase()}`;
	return fact.valueText !== undefined
		? `${value.kind}:${fact.valueText.trim().toLowerCase()}`
		: undefined;
}

function normalizedWords(text: string): string {
	return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/**
 * Whether a proposed fact provably restates a stored one: the same structured
 * value, or neither has a value and they say the same words. Pure.
 */
export function isProvenRestatement(fact: ReduceFact, stored: PlanFact): boolean {
	const incoming = factValueText(fact.value);
	const existing = storedFactValueText(stored);
	if (incoming !== undefined && existing !== undefined) return incoming === existing;
	if (incoming !== undefined || existing !== undefined) return false;
	return normalizedWords(fact.assertion) === normalizedWords(stored.assertionText);
}

/** Plan one message's changes. Pure. */
export function planReduction(
	state: { items: readonly PlanItem[]; facts: readonly PlanFact[] },
	result: ReduceResult,
	contentRevision: string,
	opts: PlanOptions
): ReductionPlan {
	const plan: ReductionPlan = { inserts: [], patches: [], facts: [], dropped: [] };
	const byId = new Map(state.items.map((item) => [item._id as string, item]));
	const patchOf = new Map<string, ItemPatch>();
	const patch = (item: PlanItem): ItemPatch => {
		let p = patchOf.get(item._id);
		if (!p) {
			p = { itemId: item._id };
			patchOf.set(item._id, p);
			plan.patches.push(p);
		}
		return p;
	};

	// ── Items ──
	for (const [index, proposal] of result.items.entries()) {
		const match = proposal.matchItemId ? byId.get(proposal.matchItemId) : undefined;
		if (match && match.status !== 'superseded') {
			const p = patch(match);
			const added = newEvidence(match.evidence, proposal.evidence, opts.source, contentRevision);
			if (added.length > 0) p.addEvidence = [...(p.addEvidence ?? []), ...added];
			const fill: ItemPatch['fill'] = {};
			if (!match.due && proposal.due) fill.due = proposal.due;
			if (!match.amount && proposal.amount) fill.amount = proposal.amount;
			if (!match.options && proposal.options) fill.options = proposal.options;
			if (Object.keys(fill).length > 0) p.fill = fill;
			if (match.verify === 'proposal' && proposal.verify === 'passed') p.verify = 'passed';
			// Asked again after it was closed (by a human, or reported done): a person looks.
			if (match.status !== 'open' || proposal.isReviewNeeded) p.isReviewNeeded = true;
			if (added.length > 0 || p.fill || p.verify) p.activity ??= { type: 'item_changed' };
			continue;
		}
		let possibleDuplicateOfId: Id<'threadItems'> | undefined;
		let best = 0;
		for (const item of state.items) {
			if (item.status !== 'open' || item.intent !== proposal.intent) continue;
			const score = textSimilarity(item.assertionText, proposal.assertion);
			if (score >= DUPLICATE_SIMILARITY && score > best) {
				best = score;
				possibleDuplicateOfId = item._id;
			}
		}
		plan.inserts.push({
			item: proposal,
			index,
			...(possibleDuplicateOfId ? { possibleDuplicateOfId } : {}),
		});
	}

	// ── Transitions ──
	for (const [index, t] of result.transitions.entries()) {
		const drop = (reason: DropReason) => plan.dropped.push({ kind: 'transition', index, reason });
		const item = byId.get(t.itemId);
		if (!item) {
			drop('unknown_item');
			continue;
		}
		if (opts.isOutOfOrder) {
			drop('out_of_order');
			continue;
		}
		if (t.to === 'untracked' || t.disposition === 'failed') {
			drop('model_forbidden');
			continue;
		}
		const added = newEvidence(item.evidence, t.evidence, opts.source, contentRevision);
		const current = patchOf.get(item._id);
		const statusFrom = current?.status ?? item.status;
		const dispositionFrom = current?.disposition ?? item.disposition;
		const wantsStatus = t.to !== undefined && t.to !== statusFrom;

		if (wantsStatus && isStatusLocked(item)) {
			// A human decided this item: keep their status, keep the new quotes,
			// and ask a person to look (the writer logs it as item_changed).
			const p = patch(item);
			p.isReviewNeeded = true;
			if (added.length > 0) p.addEvidence = [...(p.addEvidence ?? []), ...added];
			drop('corrected');
			continue;
		}
		if (wantsStatus && t.to && CLOSING.has(t.to) && !t.isVerified) {
			// An unsupported closing claim has no effect at all, disposition included.
			drop('unverified');
			continue;
		}
		if (wantsStatus && t.to && !isLegalStatusEdge(statusFrom, t.to, 'system')) {
			drop('illegal_edge');
			continue;
		}
		const wantsDisposition = t.disposition !== undefined && t.disposition !== dispositionFrom;
		if (
			wantsDisposition &&
			t.disposition &&
			!isLegalDispositionEdge(dispositionFrom, t.disposition)
		) {
			if (!wantsStatus) {
				drop('illegal_edge');
				continue;
			}
		}
		if (!wantsStatus && !wantsDisposition) {
			drop('no_change');
			continue;
		}
		const p = patch(item);
		if (wantsStatus && t.to) {
			p.status = t.to;
			p.completion = t.to === 'done' ? 'reported' : undefined;
			p.activity = {
				type:
					t.to === 'open' ? 'item_reopened' : t.to === 'superseded' ? 'item_replaced' : 'item_closed',
				delta: {
					statusFrom,
					statusTo: t.to,
					...(t.to === 'done' ? { completion: 'reported' as const } : {}),
				},
			};
		}
		if (
			wantsDisposition &&
			t.disposition &&
			isLegalDispositionEdge(dispositionFrom, t.disposition)
		) {
			p.disposition = t.disposition;
			p.activity ??= { type: 'item_changed' };
			p.activity.delta = { ...p.activity.delta, dispositionFrom, dispositionTo: t.disposition };
		}
		if (added.length > 0) p.addEvidence = [...(p.addEvidence ?? []), ...added];
		if (t.isReviewNeeded) p.isReviewNeeded = true;
	}

	// ── Facts ──
	if (opts.mode === 'brief' && opts.threadKind === 'mail') {
		const current = state.facts.filter((f) => f.status === 'current');
		const currentById = new Map(current.map((f) => [f._id as string, f]));
		const retired = new Set<string>();
		for (const [index, fact] of (result.facts ?? []).entries()) {
			const named = (id: string | undefined) =>
				id && !retired.has(id) ? currentById.get(id) : undefined;
			const superseded = named(fact.supersedes);
			const contradicted = named(fact.conflictsWith);
			const sameKey =
				named(fact.matchFactId) ??
				current.find((f) => f.factKey === fact.key && !retired.has(f._id));
			if (superseded) {
				if (fact.isVerified && !opts.isOutOfOrder) {
					retired.add(superseded._id);
					plan.facts.push({ kind: 'supersede', factId: superseded._id });
					plan.facts.push({ kind: 'insert', index, fact, supersedesId: superseded._id });
				} else {
					plan.facts.push({ kind: 'insert', index, fact, conflictsWithId: superseded._id });
					if (opts.isOutOfOrder) plan.dropped.push({ kind: 'fact', index, reason: 'out_of_order' });
				}
				continue;
			}
			if (contradicted) {
				plan.facts.push({ kind: 'insert', index, fact, conflictsWithId: contradicted._id });
				continue;
			}
			if (sameKey) {
				if (isProvenRestatement(fact, sameKey)) {
					const added = newEvidence(sameKey.evidence, fact.evidence, opts.source, contentRevision);
					if (added.length > 0) {
						plan.facts.push({ kind: 'evidence', factId: sameKey._id, addEvidence: added });
					} else {
						plan.dropped.push({ kind: 'fact', index, reason: 'no_change' });
					}
				} else {
					// Same key, not provably the same claim, nothing verified about
					// replacing it: a conflict to show, never a silent merge.
					plan.facts.push({ kind: 'insert', index, fact, conflictsWithId: sameKey._id });
				}
				continue;
			}
			plan.facts.push({ kind: 'insert', index, fact });
		}
	}

	return plan;
}

/** Whether the plan writes anything at all. */
export function isEmptyPlan(plan: ReductionPlan): boolean {
	return plan.inserts.length === 0 && plan.patches.length === 0 && plan.facts.length === 0;
}

/** Item proposals the plan treats as asked by "us" or someone else (for the projection). */
export function isOpenUsItem(item: Pick<ReduceItem, 'responsible'>): boolean {
	return responsibilityOf(item.responsible) !== 'them';
}
