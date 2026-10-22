import type { GenericValidator } from 'convex/values';

/**
 * How an object treats a key its validator does not declare.
 *
 * `reject` is Convex's own rule, and what a producer is held to: `returns`
 * refuses an unexpected field, so a check that stands in for `returns` must too.
 *
 * `ignore` is for a CONSUMER reading across a rolling deploy. A backend one
 * release ahead may answer with a field this build has never heard of (an
 * additive change is a compatible one), and a worker that refused the whole
 * answer for it would stop working until it was updated. The field is left on
 * the value, unread; every declared field is still checked.
 */
export type UnknownKeys = 'reject' | 'ignore';

export interface MatchOptions {
	readonly unknownKeys?: UnknownKeys;
}

/**
 * Does an untrusted value satisfy a Convex validator?
 *
 * WHY THIS EXISTS. Convex enforces `args` and `returns` validators at the
 * function boundary, but a value that has already crossed one — a workpool
 * `onComplete` callback's `result.returnValue`, typed `any` by the component, or
 * a worker reading a Convex answer over HTTP — arrives as raw data with no gate
 * of its own. A cast is not a check.
 *
 * SO THE VALIDATOR IS THE CHECK. The same object the producing function
 * declares as its `returns` is the one a consumer matches against here, rather
 * than a hand-written field list beside it that drifts the first time an arm
 * gains a field.
 *
 * Convex's own semantics, deliberately:
 *   · objects are EXACT by default — an unexpected key fails, exactly as
 *     `v.object` does (see {@link UnknownKeys} for the consumer exception);
 *   · `undefined` is ABSENT, not a value, so an optional field may carry it;
 *   · `v.id()` is a string on the wire, so that is all that can be checked here
 *     (table membership needs a database read and is not a shape question).
 *
 * FAIL CLOSED ON THE UNKNOWN. Convex documents that new validator kinds may
 * appear in future releases, so an unrecognised `kind` answers `false` rather
 * than waving the value through: a consumer that cannot check a shape must not
 * claim it did.
 */
export function matchesValidator(
	validator: GenericValidator,
	value: unknown,
	options: MatchOptions = {}
): boolean {
	return validatorMismatch(validator, value, options) === null;
}

/**
 * Where `value` first fails `validator`, as a path and the kind expected there
 * (`$.credentials.imapPort: expected float64`), or `null` when it matches.
 *
 * The answer is built from the VALIDATOR's field names and array positions,
 * NEVER from the value: not what was found at the place, nor an unexpected key
 * or a record key, which are data too. Worker credentials cross the wire this
 * checks, and a mismatch report ends up in a log.
 */
export function validatorMismatch(
	validator: GenericValidator,
	value: unknown,
	options: MatchOptions = {}
): string | null {
	return mismatchAt(validator, value, '$', options.unknownKeys ?? 'reject');
}

function mismatchAt(
	validator: GenericValidator,
	value: unknown,
	path: string,
	unknownKeys: UnknownKeys
): string | null {
	const expected = (what: string) => `${path}: expected ${what}`;
	switch (validator.kind) {
		case 'any':
			return null;
		case 'null':
			return value === null ? null : expected('null');
		case 'string':
		// A document id is a string on the wire; see the note above.
		case 'id':
			return typeof value === 'string' ? null : expected(validator.kind);
		case 'float64':
			return typeof value === 'number' ? null : expected('float64');
		case 'int64':
			return typeof value === 'bigint' ? null : expected('int64');
		case 'boolean':
			return typeof value === 'boolean' ? null : expected('boolean');
		case 'bytes':
			return value instanceof ArrayBuffer ? null : expected('bytes');
		case 'literal':
			return value === validator.value
				? null
				: expected(`literal ${formatLiteral(validator.value)}`);
		case 'array': {
			if (!Array.isArray(value)) return expected('array');
			for (let i = 0; i < value.length; i += 1) {
				const inner = mismatchAt(validator.element, value[i], `${path}[${i}]`, unknownKeys);
				if (inner !== null) return inner;
			}
			return null;
		}
		case 'object':
			return objectMismatch(validator.fields, value, path, unknownKeys);
		case 'record': {
			if (!isPlainRecord(value)) return expected('record');
			for (const key of Object.keys(value)) {
				if (mismatchAt(validator.key, key, path, unknownKeys) !== null) {
					return `${path}: a key does not match the record's key validator`;
				}
				// Record keys are data, so the path names the record, not the key.
				const inner = mismatchAt(validator.value, value[key], `${path}[*]`, unknownKeys);
				if (inner !== null) return inner;
			}
			return null;
		}
		case 'union':
			return validator.members.some(
				(member) => mismatchAt(member, value, path, unknownKeys) === null
			)
				? null
				: `${path}: matches no member of the union`;
		default:
			return `${path}: validator kind ${JSON.stringify(validator.kind)} cannot be checked`;
	}
}

function objectMismatch(
	fields: Record<string, GenericValidator>,
	value: unknown,
	path: string,
	unknownKeys: UnknownKeys
): string | null {
	if (!isPlainRecord(value)) return `${path}: expected object`;
	if (unknownKeys === 'reject') {
		for (const key of Object.keys(value)) {
			if (value[key] === undefined) continue;
			if (!Object.prototype.hasOwnProperty.call(fields, key)) {
				// The key is not named: an unexpected key is data, and may be a secret.
				return `${path}: unexpected field`;
			}
		}
	}
	for (const [key, field] of Object.entries(fields)) {
		const at = `${path}.${key}`;
		const present = Object.prototype.hasOwnProperty.call(value, key) && value[key] !== undefined;
		if (!present) {
			if (field.isOptional !== 'optional') return `${at}: missing`;
			continue;
		}
		const inner = mismatchAt(field, value[key], at, unknownKeys);
		if (inner !== null) return inner;
	}
	return null;
}

/**
 * A literal validator's value as it reads in a report. `JSON.stringify` throws
 * on a bigint, and a union tries its arms in turn, so an `int64` literal arm
 * that misses must still format rather than abort the arms after it.
 */
function formatLiteral(literal: string | number | boolean | bigint): string {
	return typeof literal === 'bigint' ? `${literal}n` : JSON.stringify(literal);
}

/**
 * A record, in the sense Convex means it: `null` is its own type and an array
 * is an array, so neither may stand in for an object.
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
