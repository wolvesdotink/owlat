/**
 * Where each held change came from (review round 7 F1), pure. A held update
 * (`threadItems.pendingUpdate`) records, per field, the source that proposed
 * it (`fieldSources`; `wording` covers assertion and display, a removal is
 * recorded under the field it removes), and each held transition carries its
 * own `sourceKey`. A purge of a message therefore drops exactly the held
 * fields that message proposed, and, for a confirmation that already applied
 * them, puts back the value the item had before (`confirmedFrom`).
 */

import type { Doc } from '../../_generated/dataModel';
import { counterpartyKeyOf } from './parties';

type Held = NonNullable<Doc<'threadItems'>['pendingUpdate']>;
type HeldValues = Omit<Held, 'evidence'>;
type FieldSource = NonNullable<Held['fieldSources']>[number];
export type HeldField = FieldSource['field'];
type ConfirmedFrom = NonNullable<Doc<'threadItems'>['confirmedFrom']>;

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

/**
 * A standing confirmation that applied fields a purged message proposed: the
 * item gets those fields back as they were before the confirmation, and the
 * snapshot forgets them. Null when the confirmation applied nothing purged.
 */
export function revertPurgedConfirmation(
	item: Pick<Doc<'threadItems'>, 'requester' | 'responsible' | 'confirmedFrom'>,
	keys: ReadonlySet<string>
): {
	patch: Partial<Doc<'threadItems'>>;
	confirmedFrom: ConfirmedFrom;
} | null {
	const from = item.confirmedFrom;
	const applied = from?.pendingUpdate;
	if (!from || !applied) return null;
	const gone = purgedFields(applied, keys);
	if (gone.size === 0) return null;
	const patch: Partial<Doc<'threadItems'>> = {};
	const put = <K extends keyof Doc<'threadItems'>>(key: K, value: Doc<'threadItems'>[K]) => {
		patch[key] = value;
	};
	for (const field of gone) {
		if (field === 'due') put('due', from.due);
		if (field === 'amount') put('amount', from.amount);
		if (field === 'options') put('options', from.options);
		if (field === 'wording' && from.assertion !== undefined) {
			put('assertion', from.assertion);
			if (from.display) put('display', from.display);
		}
		if (field === 'requester' && from.requester) put('requester', from.requester);
		if (field === 'responsible' && from.responsible) put('responsible', from.responsible);
		if (field === 'beneficiary') put('beneficiary', from.beneficiary);
		if (field === 'responsibility' && from.responsibility) {
			put('responsibility', from.responsibility);
		}
	}
	if (patch.requester || patch.responsible) {
		put(
			'counterpartyKey',
			counterpartyKeyOf({
				requester: patch.requester ?? item.requester,
				responsible: patch.responsible ?? item.responsible,
			})
		);
	}
	return { patch, confirmedFrom: { ...from, pendingUpdate: withoutSources(applied, keys) } };
}
