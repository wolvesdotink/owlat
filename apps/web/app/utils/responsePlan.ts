/**
 * Answer mode's response plan (SPEC §6), the pure part: which brief items a
 * reply plans for, what each item's stance and coverage read as, and the
 * composer footer's line ("3 of 4 addressed · 1 needs a file · new promise
 * noted: …"). The composable (`useResponsePlan`) holds the state; the brief's
 * items read it through `RESPONSE_PLAN` without every component in between
 * passing it along.
 */
import type { ComputedRef, InjectionKey } from 'vue';
import type { BriefItemView } from '../../../api/convex/mail/interpret/briefShape';
import type { CoverageVerdict, ResponseStance } from '@owlat/shared/threadBrief';

/** A brief item the reply plans for: open, tracked, ours or of unclear owner. */
export function isPlanItem(
	item: Pick<BriefItemView, 'status' | 'verify' | 'responsibility'>
): boolean {
	return item.status === 'open' && item.verify !== 'proposal' && item.responsibility !== 'them';
}

export interface PlanCoverageEntry {
	itemId: string;
	verdict: CoverageVerdict;
}

export interface PlanFileClaim {
	text: string;
	isMatched: boolean;
}

export interface PlanPromise {
	text: string;
	itemId?: string;
}

/** What the composer's footer line is made of; null while there is nothing to say. */
export interface PlanStatus {
	addressed: number;
	total: number;
	needsFile: number;
	promise?: string;
}

/**
 * The footer's parts. Nothing before the draft says anything: "0 of 3" on an
 * untouched reply reads like a warning. Items the reply skips do not count.
 */
export function planStatusOf(input: {
	stances: ReadonlyMap<string, ResponseStance>;
	coverage: readonly PlanCoverageEntry[];
	fileClaims: readonly PlanFileClaim[];
	newPromises: readonly PlanPromise[];
	isChecked: boolean;
	hasText: boolean;
}): PlanStatus | null {
	if (!input.hasText || !input.isChecked) return null;
	const planned = [...input.stances].filter(([, stance]) => stance !== 'skip').map(([id]) => id);
	const total = planned.length;
	const needsFile = input.fileClaims.filter((c) => !c.isMatched).length;
	if (total === 0 && needsFile === 0 && input.newPromises.length === 0) return null;
	const verdicts = new Map(input.coverage.map((c) => [c.itemId, c.verdict]));
	const addressed = planned.filter((id) => verdicts.get(id) === 'addressed').length;
	const promise = input.newPromises.find((p) => !p.itemId)?.text ?? input.newPromises[0]?.text;
	return { addressed, total, needsFile, ...(promise ? { promise } : {}) };
}

/**
 * Items a "File missing" chip goes on: a file item the draft addresses while
 * it says a file is attached that is not.
 */
export function fileMissingItemIds(
	items: readonly Pick<BriefItemView, 'id' | 'facets'>[],
	coverage: readonly PlanCoverageEntry[],
	fileClaims: readonly PlanFileClaim[]
): Set<string> {
	if (!fileClaims.some((c) => !c.isMatched)) return new Set();
	const addressed = new Set(
		coverage.filter((c) => c.verdict !== 'notAddressed').map((c) => c.itemId)
	);
	return new Set(
		items.filter((i) => i.facets.includes('file') && addressed.has(i.id)).map((i) => i.id)
	);
}

/** What a brief item in Answer mode reads of the plan. */
export interface ResponsePlanView {
	stanceOf: (itemId: string) => ResponseStance;
	setStance: (itemId: string, stance: ResponseStance) => void;
	/** Items the draft addresses (shown as "Addressed in draft", never "Done"). */
	addressed: ComputedRef<readonly string[]>;
	fileMissing: ComputedRef<ReadonlySet<string>>;
}

export const RESPONSE_PLAN: InjectionKey<ResponsePlanView> = Symbol('responsePlan');
