/**
 * Response plans (SPEC §6): the pure rules. Which items a reply's plan holds,
 * the stance each one starts with, how the owner's choices merge over the
 * defaults, the draft hash a plan is bound to, and the objections of the
 * `item_coverage` auto-send gate.
 *
 * Pure (no ctx, no 'use node'): the plan store (`responsePlan.ts`), the gate
 * read (`planGate.ts`) and the drafters share it, and the tests run it
 * without Convex.
 */

import type {
	BriefCompleteness,
	CoverageVerdict,
	ItemConsequenceKind,
	ItemFacet,
	ItemIntent,
	ItemResponsibility,
	ItemStatus,
	ItemVerifyState,
	PlanVerdict,
	ResponseStance,
} from '@owlat/shared/threadBrief';
import { defaultStance } from '@owlat/shared/threadBriefRules';

/**
 * Items one plan holds at most (the drafter's prompt lists every one). Past it
 * the plan is marked overflowing and its check is incomplete: nothing is
 * dropped silently (review D2).
 */
export const MAX_PLAN_ITEMS = 200;

export type StanceSource = 'default' | 'owner' | 'policy';

export interface PlanStance<Id extends string = string> {
	itemId: Id;
	stance: ResponseStance;
	source: StanceSource;
}

/** One item of a plan, as the drafter and the self-check see it. */
export interface PlanItem<Id extends string = string> {
	id: Id;
	revision: number;
	intent: ItemIntent;
	facets: ItemFacet[];
	consequences?: ItemConsequenceKind[];
	responsibility: ItemResponsibility;
	/** The item in the mail's words (unsealed `assertion`): untrusted. */
	text: string;
	duePhrase?: string;
	amount?: { value: number; currency: string };
	options?: string[];
}

/** The fields that decide whether an item belongs in a reply's plan. */
export interface PlanCandidate {
	status: ItemStatus;
	responsibility: ItemResponsibility;
	verify: ItemVerifyState;
}

/**
 * Whether a reply's plan covers an item: an open, tracked item that is ours
 * or whose owner is unclear. Items the other side owes are not the reply's to
 * answer, and an unconfirmed proposal ("Check this") is not an obligation
 * until someone confirms it.
 */
export function isPlanRelevant(item: PlanCandidate): boolean {
	return item.status === 'open' && item.responsibility !== 'them' && item.verify !== 'proposal';
}

/**
 * The plan's stances, one per item in `items` order: the owner's (or a
 * policy's) choice where one was made, otherwise the default (`answer`, or
 * `clarify` while a clarification slot of the item is unanswered). A default
 * stance stored earlier is recomputed, so an answered slot moves the item from
 * `clarify` to `answer`.
 */
export function planStances<Id extends string>(
	items: readonly Pick<PlanItem<Id>, 'id'>[],
	chosen: readonly PlanStance<Id>[],
	openSlotItemIds: ReadonlySet<string>
): PlanStance<Id>[] {
	const byItem = new Map(chosen.filter((s) => s.source !== 'default').map((s) => [s.itemId, s]));
	return items.map((item) => {
		const kept = byItem.get(item.id);
		if (kept) return { itemId: item.id, stance: kept.stance, source: kept.source };
		return {
			itemId: item.id,
			stance: defaultStance({ hasOpenSlot: openSlotItemIds.has(item.id) }),
			source: 'default',
		};
	});
}

export { draftHashOf, normalizeDraftText } from '@owlat/shared/threadBriefRules';

export interface DraftSpan {
	start: number;
	end: number;
}

export interface CoverageEntry<Id extends string = string> {
	itemId: Id;
	verdict: CoverageVerdict;
	spans: DraftSpan[];
}

export interface FileClaim {
	text: string;
	spans: DraftSpan[];
	isMatched: boolean;
	attachmentId?: string;
}

export interface NewPromise<Id extends string = string> {
	text: string;
	spans: DraftSpan[];
	duePhrase?: string;
	amount?: { value: number; currency: string };
	/** The item the promise answers, when it answers one. */
	itemId?: Id;
}

export interface PlanCoverage<Id extends string = string> {
	coverage: CoverageEntry<Id>[];
	fileClaims: FileClaim[];
	newPromises: NewPromise<Id>[];
	/** More claims or promises than the bound: the check did not see them all. */
	isIncomplete: boolean;
}

/**
 * The plan's verdict once a draft was checked: `covered` when every item the
 * reply takes a stance on is addressed and every file the draft says is
 * attached is attached, `gaps` otherwise.
 */
export function planVerdictOf<Id extends string>(
	stances: readonly PlanStance<Id>[],
	checked: Pick<PlanCoverage<Id>, 'coverage' | 'fileClaims'>
): Extract<PlanVerdict, 'covered' | 'gaps'> {
	const verdicts = new Map(checked.coverage.map((c) => [c.itemId, c.verdict]));
	const isMissing = stances.some(
		(s) => s.stance !== 'skip' && verdicts.get(s.itemId) !== 'addressed'
	);
	return isMissing || checked.fileClaims.some((c) => !c.isMatched) ? 'gaps' : 'covered';
}

// ── The item_coverage auto-send gate ───────────────────────────────────────

export const ITEM_COVERAGE_OBJECTIONS = [
	'no_plan',
	'pending_check',
	'stale_draft',
	'stale_attachments',
	'stale_items',
	'incomplete',
	'incomplete_check',
	'not_addressed',
	'unclear_owner',
	'unauthorized_commitment',
	'file_missing',
] as const;
export type ItemCoverageObjection = (typeof ITEM_COVERAGE_OBJECTIONS)[number];

/** An item's own terms: what accepting it commits to. */
export interface ItemTerms {
	duePhrase?: string;
	amount?: { value: number; currency: string };
}

/** What the gate compares: the stored plan, and the send and thread as they are now. */
export interface ItemCoverageInput<Id extends string = string> {
	plan: {
		draftHash: string;
		threadRevision: number;
		itemRevisions: readonly { itemId: Id; revision: number }[];
		stances: readonly PlanStance<Id>[];
		coverage: readonly CoverageEntry<Id>[];
		fileClaims: readonly Pick<FileClaim, 'isMatched'>[];
		newPromises: readonly Pick<NewPromise<Id>, 'itemId' | 'duePhrase' | 'amount'>[];
		verdict: PlanVerdict;
		planRevision?: number;
		checkedPlanRevision?: number;
		attachmentSetHash?: string;
		isCheckIncomplete?: boolean;
	} | null;
	/** Hash of the exact outgoing draft text; null when there is none. */
	draftHash: string | null;
	/** Hash of the exact outgoing attachment set. */
	attachmentSetHash: string;
	/** `threadBriefs.interpretationRevision` now; null when there is no brief. */
	threadRevision: number | null;
	completeness: BriefCompleteness | null;
	/** The thread's plan-relevant items now (see {@link isPlanRelevant}), with their terms. */
	items: readonly ({ id: Id; revision: number; responsibility: ItemResponsibility } & ItemTerms)[];
	/** More relevant items than a plan holds. */
	isItemsOverflow: boolean;
}

function sameWords(a: string, b: string): boolean {
	const norm = (t: string) => t.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
	return norm(a) === norm(b);
}

/**
 * Whether a commitment stays within what the owner accepted (review D3): it
 * names the item, the owner (or a policy) chose to accept that item, and the
 * terms the draft commits to are the item's own: no other amount, no deadline
 * the item does not carry. Anything else is unauthorised.
 */
export function isCommitmentAuthorised<Id extends string>(
	promise: Pick<NewPromise<Id>, 'itemId' | 'duePhrase' | 'amount'>,
	stances: readonly PlanStance<Id>[],
	items: ReadonlyMap<string, ItemTerms>
): boolean {
	if (!promise.itemId) return false;
	const stance = stances.find((s) => s.itemId === promise.itemId);
	if (stance?.stance !== 'accept' || stance.source === 'default') return false;
	const terms = items.get(promise.itemId);
	if (!terms) return false;
	if (promise.amount) {
		if (!terms.amount) return false;
		if (
			terms.amount.value !== promise.amount.value ||
			terms.amount.currency.toUpperCase() !== promise.amount.currency.toUpperCase()
		) {
			return false;
		}
	}
	if (promise.duePhrase) {
		if (!terms.duePhrase || !sameWords(terms.duePhrase, promise.duePhrase)) return false;
	}
	return true;
}

/**
 * Why the gate objects to sending this draft unattended (SPEC §6), in a fixed
 * order; empty when it does not. Restrict-only by construction: the caller
 * can only hold a send on the result.
 *
 *   - no plan, or no check of the plan as it stands now (pending, or checked
 *     against an older stance revision: D1);
 *   - a check of another draft text, another attachment set, or another state
 *     of the thread's items (draft hash, attachment-set hash, thread revision
 *     and every item revision are bound);
 *   - interpretation not complete; more items than a plan holds, or more
 *     claims than a check reads (D2);
 *   - an item the reply should answer is not addressed: a partial or missing
 *     verdict, or a `clarify` stance; only an explicit `skip` passes an item;
 *   - an item whose owner is unclear;
 *   - a commitment no stance authorised, or one whose terms are not the
 *     accepted item's own (D3);
 *   - a file the draft says is attached and is not.
 */
export function itemCoverageObjections<Id extends string>(
	input: ItemCoverageInput<Id>
): ItemCoverageObjection[] {
	const { plan } = input;
	if (!plan) return ['no_plan'];
	const out: ItemCoverageObjection[] = [];
	const isChecked =
		plan.verdict !== 'pending' &&
		plan.verdict !== 'stale' &&
		plan.checkedPlanRevision !== undefined &&
		plan.checkedPlanRevision === (plan.planRevision ?? 0);
	if (!isChecked) out.push('pending_check');
	if (input.draftHash === null || plan.draftHash !== input.draftHash) out.push('stale_draft');
	if (plan.attachmentSetHash !== input.attachmentSetHash) out.push('stale_attachments');
	const planned = new Map(plan.itemRevisions.map((r) => [r.itemId, r.revision]));
	const isStale =
		input.threadRevision === null ||
		plan.threadRevision !== input.threadRevision ||
		input.items.length !== planned.size ||
		input.items.some((item) => planned.get(item.id) !== item.revision);
	if (isStale) out.push('stale_items');
	if (input.completeness !== 'complete') out.push('incomplete');
	if (input.isItemsOverflow || plan.isCheckIncomplete === true) out.push('incomplete_check');

	const verdicts = new Map(plan.coverage.map((c) => [c.itemId, c.verdict]));
	const answered = plan.stances.filter((s) => s.stance !== 'skip');
	if (answered.some((s) => s.stance === 'clarify' || verdicts.get(s.itemId) !== 'addressed')) {
		out.push('not_addressed');
	}
	const unclear = new Set(
		input.items.filter((i) => i.responsibility === 'unclear').map((i) => i.id as string)
	);
	if (answered.some((s) => unclear.has(s.itemId))) out.push('unclear_owner');

	const terms = new Map<string, ItemTerms>(input.items.map((i) => [i.id, i]));
	if (plan.newPromises.some((p) => !isCommitmentAuthorised(p, plan.stances, terms))) {
		out.push('unauthorized_commitment');
	}
	if (plan.fileClaims.some((c) => !c.isMatched)) out.push('file_missing');
	return out;
}

const OBJECTION_TEXT: Record<ItemCoverageObjection, string> = {
	no_plan: 'the draft has no response plan',
	pending_check: 'the response plan was not checked as it stands now',
	stale_draft: 'the coverage check was made for a different draft text',
	stale_attachments: 'the coverage check was made for different attachments',
	stale_items: 'the thread’s items changed since the coverage check',
	incomplete: 'the thread’s interpretation is incomplete',
	incomplete_check: 'the coverage check could not cover every item or claim',
	not_addressed: 'an open item the reply should answer is not addressed',
	unclear_owner: 'an open item has no clear owner',
	unauthorized_commitment: 'the draft makes a commitment nobody authorised',
	file_missing: 'the draft says a file is attached that is not',
};

/** The gate's human-readable reason, or null when nothing objects. */
export function itemCoverageReason(objections: readonly ItemCoverageObjection[]): string | null {
	if (objections.length === 0) return null;
	return `Item coverage: ${objections.map((o) => OBJECTION_TEXT[o]).join('; ')}; not auto-sending — routing to human review.`;
}
