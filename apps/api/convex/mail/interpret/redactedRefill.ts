/**
 * Refilling what a message purge redacted (review round 4, F3). A purge lists
 * the fields it blanked in `threadItems.redactedFields` (`purgeClaims.ts`).
 * When a VERIFIED claim later matches the item, it refills exactly those of
 * the listed fields it states, and nothing else: wording, parties and values
 * a surviving source set stay as they are. Each refilled field is stamped in
 * `fieldSources` and taken off the marker (which goes when empty).
 *
 * Planner (`reducePlan.ts`) → fold (`fold.ts`, {@link applyRefill}) → writer
 * (`reduceWrite.ts`, {@link refillPatch}). Pure, isolate-safe.
 */

import type { Doc } from '../../_generated/dataModel';
import type { ReduceItem } from './reduceInput';
import type { ItemFieldSources } from './heldSources';
import { counterpartyKeyOf, responsibilityOf } from './parties';

type SetBy = { sourceKey: string; at: number };

/** The parts of a refilled claim the writer still has to put on the row. */
export interface RefilledFields {
	assertion?: string;
	display?: { en: string; de: string };
	requester?: ReduceItem['requester'];
	responsible?: ReduceItem['responsible'];
	beneficiary?: ReduceItem['beneficiary'];
	facets?: ReduceItem['facets'];
	consequences?: ReduceItem['consequences'];
}

const isParty = (p: { email?: string; name?: string; isUs: boolean } | null | undefined) =>
	!!p && (p.isUs || !!p.email || !!p.name);

/** The redacted fields `claim` states (so it may refill them). Pure. */
export function refillableFields(redacted: readonly string[], claim: ReduceItem): string[] {
	const states: Record<string, boolean> = {
		assertion: !!claim.assertion,
		display: !!claim.display,
		requester: isParty(claim.requester),
		responsible: isParty(claim.responsible),
		responsibility: isParty(claim.responsible),
		beneficiary: isParty(claim.beneficiary),
		due: !!claim.due,
		amount: !!claim.amount,
		options: !!claim.options?.length,
		facets: claim.facets.length > 0,
		consequences: claim.consequences !== undefined && claim.consequences !== null,
	};
	return redacted.filter((field) => states[field] === true);
}

/** `fieldSources` key of an item field. */
const PROVENANCE: Record<string, keyof ItemFieldSources | undefined> = {
	assertion: 'wording',
	display: 'wording',
	requester: 'requester',
	responsible: 'responsible',
	responsibility: 'responsibility',
	beneficiary: 'beneficiary',
	due: 'due',
	amount: 'amount',
	options: 'options',
};

/** The item as the fold holds it, the fields a refill touches. */
interface RefillTarget {
	due?: Doc<'threadItems'>['due'];
	amount?: Doc<'threadItems'>['amount'];
	options?: Doc<'threadItems'>['options'];
	assertionText?: string;
	redactedFields?: string[];
	fieldSources?: ItemFieldSources;
	refilled?: RefilledFields;
}

/** Apply a refill to the fold's item (mutates it). Pure apart from `item`. */
export function applyRefill(
	item: RefillTarget,
	claim: ReduceItem,
	fields: readonly string[],
	setBy: SetBy
): void {
	const has = (field: string) => fields.includes(field);
	const refilled: RefilledFields = { ...item.refilled };
	if (has('due')) item.due = claim.due;
	if (has('amount')) item.amount = claim.amount;
	if (has('options')) item.options = claim.options;
	if (has('assertion') || has('display')) {
		item.assertionText = claim.assertion;
		refilled.assertion = claim.assertion;
		refilled.display = claim.display;
	}
	if (has('requester')) refilled.requester = claim.requester;
	if (has('responsible') || has('responsibility')) refilled.responsible = claim.responsible;
	if (has('beneficiary')) refilled.beneficiary = claim.beneficiary;
	if (has('facets')) refilled.facets = claim.facets;
	if (has('consequences')) refilled.consequences = claim.consequences;
	item.refilled = refilled;
	const sources: ItemFieldSources = { ...item.fieldSources };
	for (const field of fields) {
		const key = PROVENANCE[field];
		if (key) sources[key] = setBy;
	}
	item.fieldSources = sources;
	const left = (item.redactedFields ?? []).filter((field) => !fields.includes(field));
	item.redactedFields = left.length > 0 ? left : undefined;
}

/**
 * What the writer puts on the row for a refill: the refilled text (still to
 * be sealed by the caller), parties, facets and consequences, and the
 * responsibility and counterparty that follow from the refilled parties.
 */
export function refillPatch(
	row: Pick<Doc<'threadItems'>, 'requester' | 'responsible' | 'responsibility'>,
	refilled: RefilledFields
): {
	patch: Partial<Doc<'threadItems'>>;
	text?: { assertion: string; display: { en: string; de: string } };
} {
	const patch: Partial<Doc<'threadItems'>> = {};
	if (refilled.requester) patch.requester = refilled.requester;
	if (refilled.responsible) {
		patch.responsible = refilled.responsible;
		patch.responsibility = responsibilityOf(refilled.responsible);
	}
	if (refilled.beneficiary) patch.beneficiary = refilled.beneficiary;
	if (refilled.facets) patch.facets = refilled.facets;
	if (refilled.consequences) patch.consequences = refilled.consequences;
	if (refilled.requester || refilled.responsible) {
		patch.counterpartyKey = counterpartyKeyOf({
			requester: refilled.requester ?? row.requester,
			responsible: refilled.responsible ?? row.responsible,
		});
	}
	return {
		patch,
		...(refilled.assertion && refilled.display
			? { text: { assertion: refilled.assertion, display: refilled.display } }
			: {}),
	};
}
