import type { DatabaseReader } from '../../_generated/server';
import type { Doc, Id } from '../../_generated/dataModel';
import type { ConditionTypeModule, ContactPropertyCondition, PropertyOperator } from '../types';

const BUILT_IN_FIELDS = new Set(['email', 'firstName', 'lastName', 'source']);

export interface ContactPropertyLookup {
	propertyIds: Map<string, Id<'contactProperties'>>;
	values: Map<string, unknown>;
}

const VALID_OPERATORS: ReadonlySet<PropertyOperator> = new Set([
	'equals',
	'not_equals',
	'contains',
	'not_contains',
	'gt',
	'lt',
	'gte',
	'lte',
	'is_empty',
	'not_empty',
	'is_true',
	'is_false',
]);

function applyOperator(
	operator: PropertyOperator,
	fieldValue: unknown,
	conditionValue: unknown
): boolean {
	switch (operator) {
		case 'equals':
			return String(fieldValue ?? '').toLowerCase() === String(conditionValue ?? '').toLowerCase();
		case 'not_equals':
			return String(fieldValue ?? '').toLowerCase() !== String(conditionValue ?? '').toLowerCase();
		case 'contains':
			return String(fieldValue ?? '')
				.toLowerCase()
				.includes(String(conditionValue ?? '').toLowerCase());
		case 'not_contains':
			return !String(fieldValue ?? '')
				.toLowerCase()
				.includes(String(conditionValue ?? '').toLowerCase());
		case 'gt':
			return Number(fieldValue) > Number(conditionValue);
		case 'lt':
			return Number(fieldValue) < Number(conditionValue);
		case 'gte':
			return Number(fieldValue) >= Number(conditionValue);
		case 'lte':
			return Number(fieldValue) <= Number(conditionValue);
		case 'is_empty':
			return fieldValue === undefined || fieldValue === null || fieldValue === '';
		case 'not_empty':
			return fieldValue !== undefined && fieldValue !== null && fieldValue !== '';
		case 'is_true':
			return fieldValue === true || fieldValue === 'true';
		case 'is_false':
			return fieldValue === false || fieldValue === 'false';
	}
}

export const contactPropertyConditionModule: ConditionTypeModule<
	'contact_property',
	ContactPropertyLookup
> = {
	kind: 'contact_property',
	parseCondition(raw) {
		if (!raw || typeof raw !== 'object') {
			throw new Error('contact_property: condition must be an object');
		}
		const r = raw as Record<string, unknown>;
		if (r['kind'] !== 'contact_property') {
			throw new Error('contact_property: kind must be "contact_property"');
		}
		if (typeof r['field'] !== 'string') {
			throw new Error('contact_property: field must be a string');
		}
		if (
			typeof r['operator'] !== 'string' ||
			!VALID_OPERATORS.has(r['operator'] as PropertyOperator)
		) {
			throw new Error(`contact_property: unknown operator "${r['operator'] as string}"`);
		}
		return {
			kind: 'contact_property',
			field: r['field'],
			operator: r['operator'] as PropertyOperator,
			value: r['value'] as ContactPropertyCondition['value'],
		};
	},
	async preloadLookup(ctx, conditions) {
		const lookup: ContactPropertyLookup = {
			propertyIds: new Map(),
			values: new Map(),
		};

		const customFields = new Set<string>();
		for (const c of conditions) {
			if (!BUILT_IN_FIELDS.has(c.field)) customFields.add(c.field);
		}

		// Resolve custom property IDs by key.
		for (const key of customFields) {
			const property = await ctx.db
				.query('contactProperties')
				.withIndex('by_key', (q) => q.eq('key', key))
				.first();
			if (property) lookup.propertyIds.set(key, property._id);
		}

		// Preload all values for those properties. Streamed via `for await` so the
		// value map builds without materializing an unbounded `.collect()`; this
		// whole-base preload feeds one Convex-limited segment scan (the paginated
		// match paths use `preloadLookupForContacts` and point-reads instead).
		for (const [, propertyId] of lookup.propertyIds) {
			for await (const v of ctx.db
				.query('contactPropertyValues')
				.withIndex('by_property', (q) => q.eq('propertyId', propertyId))) {
				lookup.values.set(`${v.contactId}:${propertyId}`, v.value);
			}
		}

		return lookup;
	},
	async preloadLookupForContacts(ctx, conditions, contacts) {
		const lookup: ContactPropertyLookup = {
			propertyIds: new Map(),
			values: new Map(),
		};

		const customFields = new Set<string>();
		for (const c of conditions) {
			if (!BUILT_IN_FIELDS.has(c.field)) customFields.add(c.field);
		}

		// Resolve custom property IDs by key (bounded by the distinct keys named in
		// the conditions, not by the population).
		for (const key of customFields) {
			const property = await ctx.db
				.query('contactProperties')
				.withIndex('by_key', (q) => q.eq('key', key))
				.first();
			if (property) lookup.propertyIds.set(key, property._id);
		}

		// Point-read each (contact, property) value via the by_contact_and_property
		// index — reads scale with `contacts.length × customFields`, never the whole
		// property-value column. Built-in fields are read off the contact row in
		// `evaluate`, so they need no preload here.
		for (const contact of contacts) {
			for (const [, propertyId] of lookup.propertyIds) {
				const row = await ctx.db
					.query('contactPropertyValues')
					.withIndex('by_contact_and_property', (q) =>
						q.eq('contactId', contact._id).eq('propertyId', propertyId)
					)
					.unique();
				if (row) lookup.values.set(`${contact._id}:${propertyId}`, row.value);
			}
		}

		return lookup;
	},
	evaluate(condition, contact, lookup) {
		let fieldValue: unknown;
		if (BUILT_IN_FIELDS.has(condition.field)) {
			fieldValue = (contact as unknown as Record<string, unknown>)[condition.field];
		} else {
			const propertyId = lookup.propertyIds.get(condition.field);
			if (propertyId) {
				fieldValue = lookup.values.get(`${contact._id}:${propertyId}`);
			}
		}
		return applyOperator(condition.operator, fieldValue, condition.value);
	},
};

// Re-exported for the segment evaluator's pre-module compatibility shim.
export { applyOperator as evaluateContactPropertyOperator };

export type { Doc, DatabaseReader };
