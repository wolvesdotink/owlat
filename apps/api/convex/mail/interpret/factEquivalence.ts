/**
 * When two fact claims say the same thing (review round 1 F8, round 2 F9):
 * a proven restatement has an equal structured value, compared by kind (a
 * date as an instant, money with its currency, a URL with its scheme and host
 * case-insensitive but its path and query as written, a reference
 * case-sensitive unless it is an IBAN), or no value on either side and the
 * same words. Pure.
 */

import type { ReduceFact } from './reduceInput';
import type { PlanFact } from './reducePlan';

/** A URL as compared: scheme and host case-insensitive, path, query and fragment as written. */
function urlKey(raw: string): string {
	const text = raw.trim();
	try {
		const url = new URL(text);
		return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${url.pathname}${url.search}${url.hash}`;
	} catch {
		return text;
	}
}

/** IBAN-shaped references: case and spacing never matter. */
const IBAN_SHAPE = /^[a-z]{2}\d{2}(?:\s?[a-z0-9]){10,30}$/i;

/**
 * A reference as compared: case-sensitive (an order number `Ab12` is not
 * `AB12`), whitespace collapsed; an IBAN ignores spaces and case.
 */
function refKey(raw: string): string {
	const text = raw.trim().replace(/\s+/g, ' ');
	return IBAN_SHAPE.test(text) ? text.replace(/\s/g, '').toUpperCase() : text;
}

/** Kind-specific comparable form of a value's text. Pure. */
export function valueTextKey(kind: 'ref' | 'url' | 'text', raw: string): string {
	if (kind === 'url') return urlKey(raw);
	if (kind === 'ref') return refKey(raw);
	return raw.trim().replace(/\s+/g, ' ');
}

export function factValueText(value: ReduceFact['value']): string | undefined {
	if (!value) return undefined;
	switch (value.kind) {
		case 'date':
			return `date:${value.at}`;
		case 'money':
			return `money:${value.value}:${value.currency.toUpperCase()}`;
		default:
			return `${value.kind}:${valueTextKey(value.kind, value.text)}`;
	}
}

/** The comparable form of a stored fact's value (`valueText` holds opened text). */
export function storedFactValueText(fact: PlanFact): string | undefined {
	const value = fact.value;
	if (!value) return undefined;
	if (value.kind === 'date') return `date:${value.at}`;
	if (value.kind === 'money') return `money:${value.value}:${value.currency.toUpperCase()}`;
	return fact.valueText !== undefined
		? `${value.kind}:${valueTextKey(value.kind, fact.valueText)}`
		: undefined;
}

function normalizedWords(text: string): string {
	return text
		.normalize('NFKC')
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim();
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

/** The exact stored form of a fact value (no equivalence folding): what the writer compares. Pure. */
export function exactValueKey(
	value:
		| { kind: 'date'; at: number; tz?: string }
		| { kind: 'money'; value: number; currency: string }
		| { kind: 'ref' | 'url' | 'text'; text: string }
		| undefined
): string | undefined {
	if (!value) return undefined;
	if (value.kind === 'date') return `date:${value.at}:${value.tz ?? ''}`;
	if (value.kind === 'money') return `money:${value.value}:${value.currency}`;
	return `${value.kind}:${value.text}`;
}
