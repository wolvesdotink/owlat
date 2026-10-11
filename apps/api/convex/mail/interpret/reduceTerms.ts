/**
 * A matched claim's terms against the item's, ordered per field (PR review
 * PR-1 and its follow-ups), for `reducePlan.ts`. Pure.
 */

import type { Doc } from '../../_generated/dataModel';
import type { ReduceItem } from './reduceInput';

type Terms = Partial<Pick<Doc<'threadItems'>, 'due' | 'amount' | 'options'>>;

/** The item fields the ordering reads. */
type TermsItem = Terms & Partial<Pick<Doc<'threadItems'>, 'fieldSources'>>;

/** What it writes on the plan's item patch (`reducePlan.ts ItemPatch`). */
interface TermsPatch {
	fill?: Terms;
	restamp?: Array<'due' | 'amount' | 'options'>;
	reword?: ReduceItem;
	dropped?: boolean;
}

function same(a: unknown, b: unknown): boolean {
	return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

const TERMS = ['due', 'amount', 'options'] as const;
type Term = (typeof TERMS)[number];

/**
 * A matched claim's terms (deadline, amount, options) against the item's,
 * each ordered by its own `fieldSources` stamp (PR review PR-1, F1, F2):
 *   - a term the item lacks is filled;
 *   - a verified claim newer than a term's source changes a different value,
 *     and the item takes the claim's wording with it, so the wording never
 *     states the old term (`reword`, wording stamped);
 *   - a verified newer claim stating the same value moves the term's stamp
 *     to it (`restamp`), like a status reaffirmation, so a later-arriving
 *     older claim cannot change it;
 *   - an older verified claim with a different value changes nothing and is
 *     reported (`dropped`), its quote kept.
 * `skip`: fields a refill writes already. Mutates `p`.
 */
export function applyTermUpdates(
	p: TermsPatch,
	match: TermsItem,
	claim: ReduceItem,
	setBy: { sourceKey: string; at: number },
	skip: readonly string[]
): void {
	const fill: Terms = {};
	const restamp: Term[] = [];
	let isChanged = false;
	for (const field of TERMS) {
		const value = claim[field];
		if (!value || skip.includes(field)) continue;
		if (!match[field]) {
			(fill as Record<string, unknown>)[field] = value;
			continue;
		}
		if (claim.verify !== 'passed') continue;
		const isNewer = advancesStamp(match.fieldSources?.[field], setBy);
		if (same(value, match[field])) {
			if (isNewer) restamp.push(field);
		} else if (isNewer) {
			(fill as Record<string, unknown>)[field] = value;
			isChanged = true;
		} else {
			p.dropped = true;
		}
	}
	if (Object.keys(fill).length > 0) p.fill = { ...p.fill, ...fill };
	if (restamp.length > 0) p.restamp = restamp;
	if (isChanged && !skip.includes('assertion')) p.reword = claim;
}

/**
 * Does a reaffirmation from `setBy` take a field's stamp? A newer message
 * does; on a tie of message times the later applied other source does.
 */
export function advancesStamp(
	stamp: { sourceKey: string; at: number } | undefined,
	setBy: { sourceKey: string; at: number }
): boolean {
	if (!stamp) return true;
	return setBy.at > stamp.at || (setBy.at === stamp.at && setBy.sourceKey !== stamp.sourceKey);
}
