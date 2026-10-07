/**
 * "Where things stand" as rows (plan §4.1, §8): the current facts, each with
 * the value it replaced, and conflicting statements paired up. Pure.
 */
import type { FactView } from '../../../api/convex/mail/interpret/briefShape';

/**
 * The left-hand label of a fact: its entity, from the stored key. Keys are a
 * JSON array `["entity","attribute","context"]` (an older format joined the
 * parts with `|`).
 */
export function factLabel(key: string): string {
	let entity = key;
	try {
		const parts: unknown = JSON.parse(key);
		if (Array.isArray(parts) && typeof parts[0] === 'string') entity = parts[0];
	} catch {
		entity = key.split('|')[0] ?? key;
	}
	entity = entity.trim();
	return entity.charAt(0).toLocaleUpperCase() + entity.slice(1);
}

/** A structured value as text ("14 Nov", "€5,350.00"), or null for none. */
export function factValueText(value: FactView['value'], locale: string): string | null {
	if (!value) return null;
	switch (value.kind) {
		case 'date':
			return new Intl.DateTimeFormat(locale, {
				day: 'numeric',
				month: 'short',
				...(value.tz ? { timeZone: value.tz } : {}),
			}).format(value.at);
		case 'money':
			return new Intl.NumberFormat(locale, { style: 'currency', currency: value.currency }).format(
				value.value
			);
		default:
			return value.text;
	}
}

export interface FactRow {
	fact: FactView;
	value: string | null;
	/** The value this fact replaced, struck through. */
	previous: string | null;
	/** A current statement that disagrees with this one. */
	conflict: { fact: FactView; value: string | null } | null;
}

export function factRows(facts: readonly FactView[], locale: string): FactRow[] {
	const byId = new Map(facts.map((f) => [f.id, f]));
	const paired = new Set<string>();
	const rows: FactRow[] = [];
	for (const fact of facts) {
		if (fact.status !== 'current' || paired.has(fact.id)) continue;
		const replaced = fact.supersedesId ? byId.get(fact.supersedesId) : undefined;
		const other = fact.conflictsWithId ? byId.get(fact.conflictsWithId) : undefined;
		const conflict = other && other.status === 'current' ? other : undefined;
		if (conflict) paired.add(conflict.id);
		rows.push({
			fact,
			value: factValueText(fact.value, locale),
			previous: replaced
				? (factValueText(replaced.value, locale) ?? (replaced.value ? null : replaced.text))
				: null,
			conflict: conflict ? { fact: conflict, value: factValueText(conflict.value, locale) } : null,
		});
	}
	return rows;
}
