/**
 * Example values for a transactional email's data variables: sample data the
 * author stores with the template so the editor preview and a test send show
 * a realistic email.
 *
 * An example is never part of a real send. The send path validates and fills
 * from the request's `dataVariables` alone, so a required variable a request
 * leaves out is still refused when the template holds an example for it.
 *
 * The server checks every write here, and the editor checks the same rules
 * before it saves, so both refuse the same values.
 */

import { MAX_REPEAT_ITEMS } from './sendRegions';

/** One entry of a list example: a primitive or a flat object of primitives. */
export type DataVariableExampleItem =
	| string
	| number
	| boolean
	| null
	| Record<string, string | number | boolean | null>;

/** An example value as stored; `null` is no example, so it is not a value. */
export type DataVariableExampleValue = string | number | boolean | DataVariableExampleItem[];

export type DataVariableExamples = Record<string, DataVariableExampleValue>;

/**
 * Most bytes the examples of one email may take as UTF-8 JSON. They are stored
 * on the email's row and read with it, by every list of the template library
 * too, so they stay small: a few rows of an order, not a real export.
 */
export const MAX_DATA_VARIABLE_EXAMPLES_BYTES = 16_000;

/**
 * A field name inside a list entry: what `{{item.field}}` can name. Convex
 * also refuses some keys a looser rule would let through.
 */
const ITEM_FIELD_NAME = /^\w{1,64}$/;

/** `2026-11-25`, or a full timestamp such as `2026-11-25T09:30:00Z`. */
const ISO_DATE =
	/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Whether an ISO date names a real calendar day. `Date.parse` rolls an
 * impossible day over (`2026-02-30` is read as March 2), so the written year,
 * month and day are checked against the day they produce.
 */
function isCalendarDate(value: string): boolean {
	if (!ISO_DATE.test(value) || Number.isNaN(Date.parse(value))) return false;
	const [year, month, day] = value.slice(0, 10).split('-').map(Number) as [number, number, number];
	// `setUTCFullYear`, not `Date.UTC`, which reads the years 0 to 99 as 1900 to 1999.
	const date = new Date(0);
	date.setUTCFullYear(year, month - 1, day);
	return date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

const isPrimitive = (value: unknown): value is string | number | boolean | null =>
	value === null ||
	typeof value === 'string' ||
	typeof value === 'boolean' ||
	(typeof value === 'number' && Number.isFinite(value));

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' &&
	value !== null &&
	!Array.isArray(value) &&
	Object.getPrototypeOf(value) === Object.prototype;

function listItemError(item: unknown, index: number): string | null {
	if (isPrimitive(item)) return null;
	if (!isPlainObject(item)) {
		return `entry ${index + 1} must be a string, number, boolean, null or a flat object of them`;
	}
	for (const [field, value] of Object.entries(item)) {
		if (!ITEM_FIELD_NAME.test(field)) {
			return `entry ${index + 1} has the field "${field}": a field name holds only letters, digits and underscores`;
		}
		if (!isPrimitive(value)) {
			return `entry ${index + 1}, field "${field}" must be a string, number, boolean or null`;
		}
	}
	return null;
}

/**
 * Why `value` is not an example of `type`, or `null` when it is one. A string
 * for `string`, a finite number for `number`, a boolean for `boolean`, an ISO
 * date string for `date`, and for `array` a list a send would accept: at most
 * {@link MAX_REPEAT_ITEMS} entries, each a primitive or a flat object of them.
 */
export function dataVariableExampleError(type: string, value: unknown): string | null {
	switch (type) {
		case 'string':
			return typeof value === 'string' ? null : 'must be a string';
		case 'number':
			return typeof value === 'number' && Number.isFinite(value) ? null : 'must be a number';
		case 'boolean':
			return typeof value === 'boolean' ? null : 'must be true or false';
		case 'date':
			return typeof value === 'string' && isCalendarDate(value)
				? null
				: 'must be an ISO date such as 2026-11-25';
		case 'array': {
			if (!Array.isArray(value)) return 'must be a list';
			if (value.length > MAX_REPEAT_ITEMS) {
				return `can hold at most ${MAX_REPEAT_ITEMS} entries`;
			}
			for (const [index, item] of value.entries()) {
				const error = listItemError(item, index);
				if (error) return error;
			}
			return null;
		}
		default:
			return `has the unknown type "${type}"`;
	}
}

/** A refused set of examples: the variable it names, if one, and why. */
export interface DataVariableExamplesFault {
	variable?: string;
	message: string;
}

/**
 * Why `examples` cannot be stored for `schema`, or `null` when they can: each
 * names a declared variable and matches its type, and together they fit in
 * {@link MAX_DATA_VARIABLE_EXAMPLES_BYTES}.
 */
export function dataVariableExamplesFault(
	schema: Readonly<Record<string, string>> | undefined,
	examples: Readonly<Record<string, unknown>>
): DataVariableExamplesFault | null {
	const declared = schema ?? {};
	for (const [name, value] of Object.entries(examples)) {
		if (!Object.prototype.hasOwnProperty.call(declared, name)) {
			return {
				variable: name,
				message: `The example for "${name}" names a variable the email does not declare`,
			};
		}
		const type = declared[name];
		const error = type === undefined ? null : dataVariableExampleError(type, value);
		if (error) return { variable: name, message: `The example for "${name}" ${error}` };
	}
	if (
		new TextEncoder().encode(JSON.stringify(examples)).length > MAX_DATA_VARIABLE_EXAMPLES_BYTES
	) {
		return {
			message: `The examples are too large: together they must stay under ${MAX_DATA_VARIABLE_EXAMPLES_BYTES / 1000} KB as JSON`,
		};
	}
	return null;
}

/**
 * The examples that still fit `schema`: an example whose variable is gone, or
 * that no longer matches the variable's type, is dropped.
 */
export function examplesForSchema(
	schema: Readonly<Record<string, string>> | undefined,
	examples: Readonly<Record<string, DataVariableExampleValue>> | undefined
): DataVariableExamples {
	const kept: DataVariableExamples = {};
	if (!schema || !examples) return kept;
	for (const [name, value] of Object.entries(examples)) {
		const type = Object.prototype.hasOwnProperty.call(schema, name) ? schema[name] : undefined;
		if (type !== undefined && dataVariableExampleError(type, value) === null) kept[name] = value;
	}
	return kept;
}

/**
 * An example as the editor preview holds it: every preview value is text, so
 * a number or boolean is its JSON text and a list is its JSON, the way the
 * preview's conditions (`evaluateBlockCondition`) and repeats read them.
 */
export function exampleAsPreviewText(value: DataVariableExampleValue): string {
	return typeof value === 'string' ? value : JSON.stringify(value);
}
