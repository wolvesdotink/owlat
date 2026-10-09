/**
 * Where each held change came from (review round 7 F1), pure. A held update
 * (`threadItems.pendingUpdate`) records, per field, the source that proposed
 * it (`fieldSources`; `wording` covers assertion and display, a removal is
 * recorded under the field it removes), and each held transition carries its
 * own `sourceKey`. A purge of a message therefore drops exactly the held
 * fields that message proposed; and, through the item's standing
 * `fieldSources`, redacts exactly the shown fields it set.
 */

import type { Doc } from '../../_generated/dataModel';
import { counterpartyKeyOf, responsibilityOf } from './parties';

type Held = NonNullable<Doc<'threadItems'>['pendingUpdate']>;
type HeldValues = Omit<Held, 'evidence'>;
type FieldSource = NonNullable<Held['fieldSources']>[number];
export type HeldField = FieldSource['field'];

/** The stored keys a held field stands for. */
const KEYS_OF: Record<HeldField, ReadonlyArray<keyof HeldValues>> = {
	due: ['due'],
	amount: ['amount'],
	options: ['options'],
	wording: ['assertion', 'display'],
	requester: ['requester'],
	responsible: ['responsible'],
	beneficiary: ['beneficiary'],
	responsibility: ['responsibility'],
};

/** The held fields a set of changes names (values and removals). Pure. */
export function heldFieldsOf(held: Partial<HeldValues>): HeldField[] {
	const fields = (Object.keys(KEYS_OF) as HeldField[]).filter((field) =>
		KEYS_OF[field].some((key) => held[key] !== undefined)
	);
	for (const removed of held.removes ?? []) if (!fields.includes(removed)) fields.push(removed);
	return fields;
}

/** The fields a set of purged source keys proposed. Pure. */
function purgedFields(held: Partial<HeldValues>, keys: ReadonlySet<string>): Set<HeldField> {
	return new Set(
		(held.fieldSources ?? []).filter((s) => keys.has(s.sourceKey)).map((s) => s.field)
	);
}

/** A held update's values without what `keys` proposed (fields, removals, transitions). Pure. */
export function withoutSources<T extends Partial<HeldValues>>(
	held: T,
	keys: ReadonlySet<string>
): T {
	const gone = purgedFields(held, keys);
	const next = { ...held };
	for (const field of gone) for (const key of KEYS_OF[field]) delete next[key];
	const removes = held.removes?.filter((field) => !gone.has(field));
	if (removes?.length) next.removes = removes;
	else delete next.removes;
	const sources = held.fieldSources?.filter((s) => !gone.has(s.field));
	if (sources?.length) next.fieldSources = sources;
	else delete next.fieldSources;
	const transitions = held.transitions?.filter((t) => !keys.has(t.sourceKey));
	if (transitions?.length) next.transitions = transitions;
	else delete next.transitions;
	return next;
}

/** Does a held update still hold anything (a value, a removal, a transition)? Pure. */
export function isHolding(held: Partial<HeldValues>): boolean {
	return heldFieldsOf(held).length > 0 || (held.transitions?.length ?? 0) > 0;
}

export type ItemFieldSources = NonNullable<Doc<'threadItems'>['fieldSources']>;
type SetBy = { sourceKey: string; at: number };

/** The provenance of every field a whole claim sets (an insert, a promotion). Pure. */
export function sourcesOfClaim(
	claim: { beneficiary?: unknown; due?: unknown; amount?: unknown; options?: unknown },
	setBy: SetBy
): ItemFieldSources {
	return {
		wording: setBy,
		requester: setBy,
		responsible: setBy,
		responsibility: setBy,
		...(claim.beneficiary ? { beneficiary: setBy } : {}),
		...(claim.due ? { due: setBy } : {}),
		...(claim.amount ? { amount: setBy } : {}),
		...(claim.options ? { options: setBy } : {}),
	};
}

/**
 * The fields an item shows that a purged message set (`fieldSources`, round
 * 8, 9): parties become unknown, responsibility unclear (counterparty key
 * recomputed), deadline, amount and options are cleared, review is flagged;
 * `isWordingPurged` tells the caller to redact the wording. Null when the
 * purged messages set none of them.
 */
export function redactSourcedFields(
	item: Pick<Doc<'threadItems'>, 'requester' | 'responsible' | 'fieldSources'>,
	keys: ReadonlySet<string>
): { patch: Partial<Doc<'threadItems'>>; isWordingPurged: boolean } | null {
	const sources = item.fieldSources;
	if (!sources) return null;
	const gone = (Object.keys(sources) as Array<keyof ItemFieldSources>).filter((field) =>
		keys.has(sources[field]!.sourceKey)
	);
	if (gone.length === 0) return null;
	const unknown = { isUs: false };
	const patch: Partial<Doc<'threadItems'>> = { isReviewNeeded: true };
	const kept: ItemFieldSources = { ...sources };
	// Every field whose stamp goes gets its neutral value (round 9): a record,
	// so a field added to `fieldSources` cannot be left out.
	const neutral: Record<keyof ItemFieldSources, () => void> = {
		wording: () => {}, // redacted by the caller (sealed text)
		requester: () => {
			patch.requester = unknown;
		},
		responsible: () => {
			patch.responsible = unknown;
			patch.responsibility = responsibilityOf(unknown);
			delete kept.responsibility;
		},
		beneficiary: () => {
			patch.beneficiary = undefined;
		},
		responsibility: () => {
			patch.responsibility = responsibilityOf(unknown);
		},
		due: () => {
			patch.due = undefined;
		},
		amount: () => {
			patch.amount = undefined;
		},
		options: () => {
			patch.options = undefined;
		},
	};
	for (const field of gone) {
		delete kept[field];
		neutral[field]();
	}
	if (patch.requester || patch.responsible) {
		patch.counterpartyKey = counterpartyKeyOf({
			requester: patch.requester ?? item.requester,
			responsible: patch.responsible ?? item.responsible,
		});
	}
	patch.fieldSources = Object.keys(kept).length > 0 ? kept : undefined;
	return { patch, isWordingPurged: gone.includes('wording') };
}
