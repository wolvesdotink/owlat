import type { GenericValidator } from 'convex/values';

/**
 * Does an untrusted value satisfy a Convex validator?
 *
 * WHY THIS EXISTS. Convex enforces `args` and `returns` validators at the
 * function boundary, but a value that has already crossed one — a workpool
 * `onComplete` callback's `result.returnValue`, typed `any` by the component —
 * arrives back inside another function as raw data with no gate of its own. The
 * shipped answer to that was a cast, which is not a check.
 *
 * SO THE VALIDATOR IS THE CHECK. The same object the producing function
 * declares as its `returns` is the one a consumer matches against here, rather
 * than a hand-written field list beside it that drifts the first time an arm
 * gains a field.
 *
 * Convex's own semantics, deliberately:
 *   · objects are EXACT — an unexpected key fails, exactly as `v.object` does;
 *   · `undefined` is ABSENT, not a value, so an optional field may carry it;
 *   · `v.id()` is a string on the wire, so that is all that can be checked here
 *     (table membership needs a database read and is not a shape question).
 *
 * FAIL CLOSED ON THE UNKNOWN. Convex documents that new validator kinds may
 * appear in future releases, so an unrecognised `kind` answers `false` rather
 * than waving the value through: a consumer that cannot check a shape must not
 * claim it did.
 */
export function matchesValidator(validator: GenericValidator, value: unknown): boolean {
	switch (validator.kind) {
		case 'any':
			return true;
		case 'null':
			return value === null;
		case 'string':
		// A document id is a string on the wire; see the note above.
		case 'id':
			return typeof value === 'string';
		case 'float64':
			return typeof value === 'number';
		case 'int64':
			return typeof value === 'bigint';
		case 'boolean':
			return typeof value === 'boolean';
		case 'bytes':
			return value instanceof ArrayBuffer;
		case 'literal':
			return value === validator.value;
		case 'array':
			return (
				Array.isArray(value) && value.every((entry) => matchesValidator(validator.element, entry))
			);
		case 'object':
			return matchesObject(validator.fields, value);
		case 'record':
			return (
				isPlainRecord(value) &&
				Object.keys(value).every(
					(key) =>
						matchesValidator(validator.key, key) && matchesValidator(validator.value, value[key])
				)
			);
		case 'union':
			return validator.members.some((member) => matchesValidator(member, value));
		default:
			return false;
	}
}

function matchesObject(fields: Record<string, GenericValidator>, value: unknown): boolean {
	if (!isPlainRecord(value)) return false;
	for (const key of Object.keys(value)) {
		if (value[key] === undefined) continue;
		if (!Object.prototype.hasOwnProperty.call(fields, key)) return false;
	}
	for (const [key, field] of Object.entries(fields)) {
		const present = Object.prototype.hasOwnProperty.call(value, key) && value[key] !== undefined;
		if (!present) {
			if (field.isOptional !== 'optional') return false;
			continue;
		}
		if (!matchesValidator(field, value[key])) return false;
	}
	return true;
}

/**
 * A record, in the sense Convex means it: `null` is its own type and an array
 * is an array, so neither may stand in for an object.
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
