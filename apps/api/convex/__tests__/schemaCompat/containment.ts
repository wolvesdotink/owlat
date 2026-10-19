import type { ValidatorJSON } from 'convex/values';

/**
 * Whether a validator accepts every value an older one accepted, proved from
 * the two validators' structure rather than from sample values. A sample
 * misses what it does not happen to hold: a `v.string()` narrowed to
 * `v.literal('fixture')` still accepts the sample `'fixture'`, and a
 * `v.string()` turned into a `v.id()` still accepts a fixture id.
 *
 * The rules follow Convex's argument validation: an object rejects a field
 * its validator does not name, an id is not any string, `v.any()` is only
 * contained by `v.any()`. Where containment cannot be proved the answer is
 * "not contained": an old object checked against a union of new objects is
 * split into its finite cases (each union member and boolean value of a
 * field, a present or absent optional field), up to {@link MAX_CASES}, and
 * every case must fit one member; anything past that, or any validator kind
 * not handled here, counts as a gap.
 *
 * Returns null when `next` accepts everything `previous` did, otherwise the
 * path and reason of the first gap; `root` names the top-level value in it.
 */
export function containmentGap(
	next: ValidatorJSON,
	previous: ValidatorJSON,
	root = '(value)'
): string | null {
	return gap(next, previous, '', root);
}

/** The most cases one object is split into before containment counts as unproved. */
export const MAX_CASES = 1_024;

type FieldJSON = { fieldType: ValidatorJSON; optional: boolean };
type ObjectJSON = Extract<ValidatorJSON, { type: 'object' }>;

function label(validator: ValidatorJSON): string {
	switch (validator.type) {
		case 'literal':
			return JSON.stringify(validator.value);
		case 'id':
			return `id of ${validator.tableName}`;
		case 'union':
			return validator.value.map(label).join(' | ');
		case 'array':
			return `${label(validator.value)}[]`;
		case 'object':
			return `{${Object.entries(validator.value)
				.map(([name, field]) => `${name}${field.optional ? '?' : ''}: ${label(field.fieldType)}`)
				.join(', ')}}`;
		default:
			return validator.type;
	}
}

/** The primitive kind a literal belongs to. */
function literalKind(value: unknown): string {
	if (typeof value === 'object' && value !== null && '$integer' in value) return 'bigint';
	return typeof value;
}

/** A union's members with nested unions flattened, and a boolean as its two literals. */
function alternatives(validator: ValidatorJSON): ValidatorJSON[] {
	if (validator.type === 'union') return validator.value.flatMap(alternatives);
	if (validator.type === 'boolean') {
		return [
			{ type: 'literal', value: true },
			{ type: 'literal', value: false },
		];
	}
	return [validator];
}

/**
 * The cases of an object, one per combination of its fields' alternatives
 * (an optional field adds the case where it is absent); null past MAX_CASES.
 */
function objectCases(previous: ObjectJSON): ObjectJSON[] | null {
	let cases: Record<string, FieldJSON>[] = [{}];
	for (const [name, field] of Object.entries(previous.value)) {
		const present = alternatives(field.fieldType).map((fieldType): FieldJSON => ({
			fieldType,
			optional: false,
		}));
		const options: (FieldJSON | null)[] = field.optional ? [null, ...present] : present;
		if (cases.length * options.length > MAX_CASES) return null;
		cases = cases.flatMap((fields) =>
			options.map((option) => (option === null ? fields : { ...fields, [name]: option }))
		);
	}
	return cases.map((value) => ({ type: 'object', value }));
}

const join = (path: string, name: string) => (path ? `${path}.${name}` : name);

function gap(
	next: ValidatorJSON,
	previous: ValidatorJSON,
	path: string,
	root: string
): string | null {
	const at = path || root;
	const narrowed = () => `${at}: accepted ${label(previous)}, now only ${label(next)}`;
	if (next.type === 'any') return null;
	if (previous.type === 'union') {
		for (const member of previous.value) {
			const problem = gap(next, member, path, root);
			if (problem) return problem;
		}
		return null;
	}
	if (next.type === 'union') {
		const members = alternatives(next);
		if (members.some((member) => gap(member, previous, path, root) === null)) return null;
		let cases: ValidatorJSON[] | null = null;
		if (previous.type === 'boolean') cases = alternatives(previous);
		if (previous.type === 'object') {
			cases = objectCases(previous);
			if (cases === null) return `${at}: too many cases to prove ${label(next)} accepts it`;
		}
		if (cases === null) return narrowed();
		const unmatched = cases.find(
			(one) => !members.some((member) => gap(member, one, path, root) === null)
		);
		return unmatched ? `${at}: accepted ${label(unmatched)}, now only ${label(next)}` : null;
	}
	switch (previous.type) {
		case 'any':
			return narrowed();
		case 'literal':
			if (next.type === 'literal') {
				return JSON.stringify(next.value) === JSON.stringify(previous.value) ? null : narrowed();
			}
			return next.type === literalKind(previous.value) ? null : narrowed();
		case 'id':
			if (next.type === 'string') return null;
			return next.type === 'id' && next.tableName === previous.tableName ? null : narrowed();
		case 'null':
		case 'number':
		case 'bigint':
		case 'commitTs':
		case 'boolean':
		case 'string':
		case 'bytes':
			return next.type === previous.type ? null : narrowed();
		case 'array':
			return next.type === 'array'
				? gap(next.value, previous.value, `${path}[]`, root)
				: narrowed();
		case 'record': {
			if (next.type !== 'record') return narrowed();
			if (previous.values.optional && !next.values.optional) return narrowed();
			return (
				gap(next.keys, previous.keys, `${path}{key}`, root) ??
				gap(next.values.fieldType, previous.values.fieldType, `${path}{}`, root)
			);
		}
		case 'object': {
			if (next.type !== 'object') return narrowed();
			for (const [name, field] of Object.entries(previous.value)) {
				const now = next.value[name];
				if (!now) return `${join(path, name)}: no longer accepted`;
				if (field.optional && !now.optional) return `${join(path, name)}: optional, now required`;
				const problem = gap(now.fieldType, field.fieldType, join(path, name), root);
				if (problem) return problem;
			}
			for (const [name, field] of Object.entries(next.value)) {
				if (!(name in previous.value) && !field.optional) {
					return `${join(path, name)}: new and required`;
				}
			}
			return null;
		}
		default:
			return narrowed();
	}
}

/**
 * `validator` without the field at `path` (`.` between fields, `[]` for every
 * array element), in every union member that has it: how a retired argument
 * is taken out of what the previous release could send.
 */
export function withoutValidatorField(validator: ValidatorJSON, path: string): ValidatorJSON {
	return dropField(validator, path.split('.'));
}

function dropField(validator: ValidatorJSON, segments: readonly string[]): ValidatorJSON {
	const [segment, ...rest] = segments;
	if (segment === undefined) return validator;
	if (validator.type === 'union') {
		return { ...validator, value: validator.value.map((member) => dropField(member, segments)) };
	}
	if (validator.type !== 'object') return validator;
	const isArray = segment.endsWith('[]');
	const name = isArray ? segment.slice(0, -2) : segment;
	const field = validator.value[name];
	if (!field) return validator;
	if (rest.length === 0) {
		const { [name]: _removed, ...kept } = validator.value;
		return { ...validator, value: kept };
	}
	const inner = (type: ValidatorJSON): ValidatorJSON =>
		isArray && type.type === 'array'
			? { ...type, value: dropField(type.value, rest) }
			: type.type === 'union'
				? { ...type, value: type.value.map(inner) }
				: dropField(type, rest);
	return {
		...validator,
		value: { ...validator.value, [name]: { ...field, fieldType: inner(field.fieldType) } },
	};
}
