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

/** Items one plan holds at most (the drafter's prompt lists every one). */
export const PLAN_ITEM_LIMIT = 25;

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

/** Whitespace-insensitive form of a draft: what the hash and the spans read. */
export function normalizeDraftText(text: string): string {
	return text
		.replace(/\r\n?/g, '\n')
		.replace(/[ \t]+/g, ' ')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

/** The hash a plan is bound to: SHA-256 of the normalized draft, 32 hex chars. */
export async function draftHashOf(text: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(normalizeDraftText(text))
	);
	return [...new Uint8Array(digest)]
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('')
		.slice(0, 32);
}

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
	/** The item the promise answers, when it answers one. */
	itemId?: Id;
}

export interface PlanCoverage<Id extends string = string> {
	coverage: CoverageEntry<Id>[];
	fileClaims: FileClaim[];
	newPromises: NewPromise<Id>[];
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
	'stale_draft',
	'stale_items',
	'incomplete',
	'not_addressed',
	'unclear_owner',
	'unauthorized_commitment',
	'file_missing',
] as const;
export type ItemCoverageObjection = (typeof ITEM_COVERAGE_OBJECTIONS)[number];

/** What the gate compares: the stored plan and the thread as it is now. */
export interface ItemCoverageInput<Id extends string = string> {
	plan: {
		draftHash: string;
		threadRevision: number;
		itemRevisions: readonly { itemId: Id; revision: number }[];
		stances: readonly PlanStance<Id>[];
		coverage: readonly CoverageEntry<Id>[];
		fileClaims: readonly Pick<FileClaim, 'isMatched'>[];
		newPromises: readonly Pick<NewPromise<Id>, 'itemId'>[];
	} | null;
	/** Hash of the draft that would be sent now; null when there is none. */
	draftHash: string | null;
	/** `threadBriefs.interpretationRevision` now; null when there is no brief. */
	threadRevision: number | null;
	completeness: BriefCompleteness | null;
	/** The thread's plan-relevant items now (see {@link isPlanRelevant}). */
	items: readonly { id: Id; revision: number; responsibility: ItemResponsibility }[];
}

/**
 * Why the gate objects to sending this draft unattended (SPEC §6), in a fixed
 * order; empty when it does not. Restrict-only by construction: the caller
 * can only hold a send on the result.
 *
 *   - no plan, or a plan for another draft text or another state of the
 *     thread's items (coverage is bound to the draft hash, the thread revision
 *     and every item revision);
 *   - interpretation not complete;
 *   - an item the reply should answer is not addressed: a partial or missing
 *     verdict, or a `clarify` stance (the owner's input is still needed);
 *     only an explicit `skip` passes an item over;
 *   - an item whose owner is unclear;
 *   - a commitment no stance authorised: a promise tied to no item, or to an
 *     item the owner (or a policy) did not choose to accept;
 *   - a file the draft says is attached and is not.
 */
export function itemCoverageObjections<Id extends string>(
	input: ItemCoverageInput<Id>
): ItemCoverageObjection[] {
	const { plan } = input;
	if (!plan) return ['no_plan'];
	const out: ItemCoverageObjection[] = [];
	if (input.draftHash === null || plan.draftHash !== input.draftHash) out.push('stale_draft');
	const planned = new Map(plan.itemRevisions.map((r) => [r.itemId, r.revision]));
	const isStale =
		input.threadRevision === null ||
		plan.threadRevision !== input.threadRevision ||
		input.items.length !== planned.size ||
		input.items.some((item) => planned.get(item.id) !== item.revision);
	if (isStale) out.push('stale_items');
	if (input.completeness !== 'complete') out.push('incomplete');

	const verdicts = new Map(plan.coverage.map((c) => [c.itemId, c.verdict]));
	const answered = plan.stances.filter((s) => s.stance !== 'skip');
	if (answered.some((s) => s.stance === 'clarify' || verdicts.get(s.itemId) !== 'addressed')) {
		out.push('not_addressed');
	}
	const unclear = new Set(
		input.items.filter((i) => i.responsibility === 'unclear').map((i) => i.id as string)
	);
	if (answered.some((s) => unclear.has(s.itemId))) out.push('unclear_owner');

	const authorised = new Set(
		plan.stances
			.filter((s) => s.stance === 'accept' && s.source !== 'default')
			.map((s) => s.itemId as string)
	);
	if (plan.newPromises.some((p) => !p.itemId || !authorised.has(p.itemId))) {
		out.push('unauthorized_commitment');
	}
	if (plan.fileClaims.some((c) => !c.isMatched)) out.push('file_missing');
	return out;
}

const OBJECTION_TEXT: Record<ItemCoverageObjection, string> = {
	no_plan: 'the draft has no checked response plan',
	stale_draft: 'the coverage check was made for a different draft text',
	stale_items: 'the thread’s items changed since the coverage check',
	incomplete: 'the thread’s interpretation is incomplete',
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
