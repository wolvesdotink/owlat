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
 *   - ORDER. Status and disposition are ordered independently, each by the
 *     message time of the source that set it (`statusSource.at`,
 *     `dispositionSource.at`): an older message's change to a field is kept
 *     as evidence only; a supported reaffirmation advances the stamp. A late
 *     message never retires a fact (`isOutOfOrder`).
 *   - A recorded or asserted completion (a send, "Mark done") is human state:
 *     like a correction, the model never moves it.
 */

import type { Doc, Id } from '../../_generated/dataModel';
import type { ActivityType, ItemStatus } from '@owlat/shared/threadBrief';
import { isLegalDispositionEdge, isLegalStatusEdge } from '@owlat/shared/threadBriefRules';
import {
	interpretationSourceKey,
	type InterpretationSource,
} from '../../lib/validators/threadBrief';
import type { ReduceEvidence, ReduceItem, ReduceResult } from './reduceInput';

export { evidenceKey, type EvidenceRef } from './evidence';
export type { FactOp, PlanFact } from './reducePlanFacts';
import { planFacts, type FactOp, type PlanFact } from './reducePlanFacts';
import { newEvidence, type EvidenceRef } from './evidence';
import { heldUpdateOf, type PlanHeld } from './reduceHeld';

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
	| 'lastTransitionAt'
	| 'statusSource'
	| 'dispositionSource'
> &
	Partial<
		Pick<Doc<'threadItems'>, 'requester' | 'responsible' | 'beneficiary' | 'responsibility'>
	> & {
		evidence: readonly EvidenceRef[];
		/** Unsealed assertion, for the duplicate check. */
		assertionText: string;
		/** Unsealed display, for the confirmed-field comparison. */
		storedDisplay?: { en: string; de: string };
	};

export interface PlanOptions {
	mode: 'brief' | 'actions';
	threadKind: 'mail' | 'team';
	/** Older than the checkpoint: the message may not retire a fact. */
	isOutOfOrder: boolean;
	/** The message being folded in (evidence identity). */
	source: InterpretationSource;
	/** Its date: order-aware transitions compare it with each field's source stamp. */
	sourceAt: number;
	/** Fact claims (by index) whose lineage names a fact this claim produced before (`fold.ts`). */
	factIdentity?: ReadonlyMap<number, string>;
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
	/** The proposals that matched this item (their claim keys join its lineage). */
	matched?: ReduceItem[];
	/** A verified claim promoting a proposal item: its text, parties, due, amount and options replace the item's. */
	promoteFrom?: ReduceItem;
	/** The message date of the transition that set the new status or disposition. */
	lastTransitionAt?: number;
	/** The source (and its message time) that set the new status / disposition. */
	statusSource?: { sourceKey: string; at: number };
	dispositionSource?: { sourceKey: string; at: number };
	/** Changes the claim may not make directly, held apart until confirmed (`reduceHeld.ts`). */
	pendingUpdate?: PlanHeld;
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
	/** Transitions on an obligation not seen yet (indexes into `transitions`), kept pending. */
	unresolved: number[];
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

function isStatusLocked(item: PlanItem): boolean {
	if (item.completion === 'recorded' || item.completion === 'asserted') return true;
	return !!item.correction && STATUS_LOCKING_CORRECTIONS.has(item.correction.kind);
}

/**
 * Does a reaffirmation from `setBy` take a field's stamp? A newer message
 * does; on a tie of message times the later applied other source does.
 */
function advancesStamp(
	stamp: { sourceKey: string; at: number } | undefined,
	setBy: { sourceKey: string; at: number }
): boolean {
	if (!stamp) return true;
	return setBy.at > stamp.at || (setBy.at === stamp.at && setBy.sourceKey !== stamp.sourceKey);
}

/** Plan one message's changes. Pure. */
export function planReduction(
	state: { items: readonly PlanItem[]; facts: readonly PlanFact[] },
	result: ReduceResult,
	contentRevision: string,
	opts: PlanOptions
): ReductionPlan {
	const plan: ReductionPlan = { inserts: [], patches: [], facts: [], dropped: [], unresolved: [] };
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
		if (match) {
			const p = patch(match);
			p.matched = [...(p.matched ?? []), proposal];
			const added = newEvidence(match.evidence, proposal.evidence, opts.source, contentRevision);
			const sourceKey = interpretationSourceKey(opts.source);
			const isSeenSource = match.evidence.some(
				(e) => interpretationSourceKey(e.source) === sourceKey
			);
			if (match.status === 'superseded') {
				// A replaced obligation is never resurrected (round 5 F4): the
				// re-read merges its quotes, nothing else.
				if (added.length > 0) {
					p.addEvidence = [...(p.addEvidence ?? []), ...added];
					p.activity ??= { type: 'item_changed' };
				}
				continue;
			}
			if (proposal.verify === 'proposal' && match.verify !== 'proposal') {
				// An unconfirmed claim never changes a tracked obligation: its quotes,
				// deadline, amount and options wait as a pending update ("Check this
				// change") until it is verified or the user confirms it.
				const pending = heldUpdateOf(proposal, match, added, {
					isConfirmed: false,
					isSeenSource,
					sourceKey,
				});
				if (pending) {
					p.pendingUpdate = pending;
					p.activity ??= { type: 'item_changed' };
				}
				if (proposal.isReviewNeeded) p.isReviewNeeded = true;
				continue;
			}
			if (added.length > 0) p.addEvidence = [...(p.addEvidence ?? []), ...added];
			const isOwnReread =
				match.evidence.length > 0 &&
				match.evidence.every((e) => interpretationSourceKey(e.source) === sourceKey);
			const isConfirmed = match.correction?.kind === 'confirmed';
			if (isConfirmed) {
				// What a person confirmed is locked (round 5 F1, round 6 F4): any
				// difference in a confirmed field (wording, parties, deadline,
				// amount, options, a value dropped) waits as a held update,
				// flagged for review.
				if (proposal.verify === 'passed' && match.verify === 'proposal') p.verify = 'passed';
				const pending = heldUpdateOf(proposal, match, [], {
					isConfirmed: true,
					isSeenSource,
					sourceKey,
				});
				if (pending) {
					p.pendingUpdate = pending;
					p.isReviewNeeded = true;
				}
			} else if (proposal.verify === 'passed' && match.verify === 'proposal') {
				// Promotion (round 4 M3): the verified claim's own text, parties,
				// deadline, amount and options replace the proposal's.
				p.verify = 'passed';
				p.promoteFrom = proposal;
			} else if (proposal.verify === 'passed' && isOwnReread) {
				// A verified re-read of the item's only source updates it in place.
				p.promoteFrom = proposal;
			} else {
				const fill: ItemPatch['fill'] = {};
				if (!match.due && proposal.due) fill.due = proposal.due;
				if (!match.amount && proposal.amount) fill.amount = proposal.amount;
				if (!match.options && proposal.options) fill.options = proposal.options;
				if (Object.keys(fill).length > 0) p.fill = fill;
			}
			// Asked again by ANOTHER message after it was closed: a person looks.
			if ((match.status !== 'open' && !isSeenSource) || proposal.isReviewNeeded) {
				p.isReviewNeeded = true;
			}
			if (added.length > 0 || p.fill || p.verify || p.promoteFrom || p.pendingUpdate) {
				p.activity ??= { type: 'item_changed' };
			}
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
	const setBy = { sourceKey: interpretationSourceKey(opts.source), at: opts.sourceAt };
	for (const [index, t] of result.transitions.entries()) {
		const drop = (reason: DropReason) => plan.dropped.push({ kind: 'transition', index, reason });
		const item = t.itemId ? byId.get(t.itemId) : undefined;
		if (!item) {
			// An obligation not seen yet: kept, and matched when its item appears (round 5 F7).
			if (t.about && (t.to || t.disposition)) plan.unresolved.push(index);
			drop('unknown_item');
			continue;
		}
		if (t.to === 'untracked' || t.disposition === 'failed') {
			drop('model_forbidden');
			continue;
		}
		if (t.to && CLOSING.has(t.to) && !t.isVerified) {
			// An unsupported closing claim has no effect at all: not on the status,
			// not on the disposition, not on the quotes, even when the item
			// already has that status.
			drop('unverified');
			continue;
		}
		const added = newEvidence(item.evidence, t.evidence, opts.source, contentRevision);
		const current = patchOf.get(item._id);
		const statusFrom = current?.status ?? item.status;
		const dispositionFrom = current?.disposition ?? item.disposition;
		// Each field is ordered by its own stamp (round 5 F3).
		const statusAt = current?.statusSource?.at ?? item.statusSource?.at;
		const dispositionAt = current?.dispositionSource?.at ?? item.dispositionSource?.at;
		const isLocked = isStatusLocked(item);
		let isTouched = false;
		let isOlder = false;

		if (t.to) {
			if (statusAt !== undefined && opts.sourceAt < statusAt) {
				isOlder = true; // a newer message set the status: evidence only (M2)
			} else if (t.to === statusFrom) {
				// A supported reaffirmation advances the stamp and names this
				// message as the source (round 5 F2); on a tie the later applied wins.
				const stamp = current?.statusSource ?? item.statusSource;
				if (!isLocked && advancesStamp(stamp, setBy)) {
					patch(item).statusSource = setBy;
					isTouched = true;
				}
			} else if (isLocked) {
				const p = patch(item);
				p.isReviewNeeded = true;
				if (added.length > 0) p.addEvidence = [...(p.addEvidence ?? []), ...added];
				drop('corrected');
				continue;
			} else if (isLegalStatusEdge(statusFrom, t.to, 'system')) {
				const p = patch(item);
				p.status = t.to;
				p.completion = t.to === 'done' ? 'reported' : undefined;
				p.statusSource = setBy;
				p.activity = {
					type:
						t.to === 'open'
							? 'item_reopened'
							: t.to === 'superseded'
								? 'item_replaced'
								: 'item_closed',
					delta: {
						statusFrom,
						statusTo: t.to,
						...(t.to === 'done' ? { completion: 'reported' as const } : {}),
					},
				};
				isTouched = true;
			} else if (!t.disposition) {
				drop('illegal_edge');
				continue;
			}
		}
		if (t.disposition) {
			if (dispositionAt !== undefined && opts.sourceAt < dispositionAt) {
				isOlder = true;
			} else if (t.disposition === dispositionFrom) {
				if (advancesStamp(current?.dispositionSource ?? item.dispositionSource, setBy)) {
					patch(item).dispositionSource = setBy;
					isTouched = true;
				}
			} else if (isLegalDispositionEdge(dispositionFrom, t.disposition)) {
				const p = patch(item);
				p.disposition = t.disposition;
				p.dispositionSource = setBy;
				p.activity ??= { type: 'item_changed' };
				p.activity.delta = { ...p.activity.delta, dispositionFrom, dispositionTo: t.disposition };
				isTouched = true;
			} else if (!t.to) {
				drop('illegal_edge');
				continue;
			}
		}
		if (!isTouched && !isOlder && added.length === 0) {
			drop('no_change');
			continue;
		}
		if (isOlder && !isTouched) drop('out_of_order');
		// Supported claims keep their quotes, whether they moved anything or not.
		if (added.length > 0) {
			const p = patch(item);
			p.addEvidence = [...(p.addEvidence ?? []), ...added];
		}
		if (isTouched) {
			const p = patch(item);
			p.lastTransitionAt = Math.max(
				p.lastTransitionAt ?? item.lastTransitionAt ?? 0,
				opts.sourceAt
			);
		}
		if (t.isReviewNeeded) patch(item).isReviewNeeded = true;
	}

	// ── Facts ──
	if (opts.mode === 'brief' && opts.threadKind === 'mail') {
		const facts = planFacts(state.facts, result.facts ?? [], contentRevision, opts);
		plan.facts.push(...facts.ops);
		plan.dropped.push(...facts.dropped);
	}

	return plan;
}
