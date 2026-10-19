import type { JSONValue, ValidatorJSON } from 'convex/values';

/**
 * Builds rows shaped like the ones a release wrote, straight from that
 * release's table validators. The rows are what an upgraded deployment already
 * has on disk, so the current schema must still accept every one of them.
 *
 * Per table, row 0 carries only required fields at every depth and row 1
 * carries every optional field with the first member of every union. The
 * rest come from walking the validator tree: for every object, at any depth,
 * a row where that object is present with its own optional fields omitted
 * (an optional field made required below the top level); for every union and
 * boolean, one row per member (a narrowed union, a changed member, a required
 * field added inside any member). A node inside a union member is reached
 * with the unions above it pinned to that member, so nested unions are
 * covered per path rather than by one shared variant index. Identical rows
 * are dropped. Values are in Convex's JSON encoding (`convexToJson`), which is
 * how the fixture stores them.
 */

/**
 * Which row to build. Paths name a node in the validator tree: `.field`,
 * `[]` for an array element, `{key}`/`{}` for a record's keys/values and
 * `|n` for a union's n-th member.
 */
type RowPlan = {
	/** Omit optional fields on every object. */
	allMinimal: boolean;
	/** Objects, by path, whose optional fields are omitted. */
	minimal: ReadonlySet<string>;
	/** Member picked per union (and per boolean: 0 = true, 1 = false); unlisted is 0. */
	choices: ReadonlyMap<string, number>;
};

const FIXTURE_STRING = 'fixture';

/** The id format the fixture uses; `validate.ts` reads the table back out of it. */
export function fixtureId(tableName: string): string {
	return `fixture-id:${tableName}`;
}

export function tableNameOfFixtureId(id: string): string | null {
	return id.startsWith('fixture-id:') ? id.slice('fixture-id:'.length) : null;
}

function valueFor(validator: ValidatorJSON, path: string, plan: RowPlan): JSONValue {
	switch (validator.type) {
		case 'null':
			return null;
		case 'number':
			return 1.5;
		case 'bigint':
		case 'commitTs':
			// `convexToJson(1n)`: an int64 is stored as its little-endian base64 bytes.
			return { $integer: 'AQAAAAAAAAA=' };
		case 'boolean':
			return (plan.choices.get(path) ?? 0) === 0;
		case 'string':
			return FIXTURE_STRING;
		case 'bytes':
			return { $bytes: 'Zml4dHVyZQ==' };
		case 'any':
			return FIXTURE_STRING;
		case 'literal':
			return validator.value;
		case 'id':
			return fixtureId(validator.tableName);
		case 'array':
			return [valueFor(validator.value, `${path}[]`, plan)];
		case 'record': {
			const key = valueFor(validator.keys, `${path}{key}`, plan);
			return {
				[typeof key === 'string' ? key : FIXTURE_STRING]: valueFor(
					validator.values.fieldType,
					`${path}{}`,
					plan
				),
			};
		}
		case 'union': {
			const choice = plan.choices.get(path) ?? 0;
			const member = validator.value[choice];
			if (!member) throw new Error('empty union in a table validator');
			return valueFor(member, `${path}|${choice}`, plan);
		}
		case 'object': {
			const minimal = plan.allMinimal || plan.minimal.has(path);
			const row: Record<string, JSONValue> = {};
			for (const [name, field] of Object.entries(validator.value)) {
				if (field.optional && minimal) continue;
				row[name] = valueFor(field.fieldType, `${path}.${name}`, plan);
			}
			return row;
		}
	}
}

const NO_PATHS: ReadonlySet<string> = new Set();

/**
 * One plan per object (that object minimal) and per union or boolean member,
 * each with the unions on the way down pinned to the member that holds it.
 */
function targetedPlans(
	validator: ValidatorJSON,
	path: string,
	pinned: ReadonlyMap<string, number>
): RowPlan[] {
	const pick = (choice: number): RowPlan => ({
		allMinimal: false,
		minimal: NO_PATHS,
		choices: new Map(pinned).set(path, choice),
	});
	switch (validator.type) {
		case 'boolean':
			return [pick(0), pick(1)];
		case 'array':
			return targetedPlans(validator.value, `${path}[]`, pinned);
		case 'record':
			return [
				...targetedPlans(validator.keys, `${path}{key}`, pinned),
				...targetedPlans(validator.values.fieldType, `${path}{}`, pinned),
			];
		case 'union':
			return validator.value.flatMap((member, choice) => [
				pick(choice),
				...targetedPlans(member, `${path}|${choice}`, new Map(pinned).set(path, choice)),
			]);
		case 'object':
			return [
				{ allMinimal: false, minimal: new Set([path]), choices: pinned },
				...Object.entries(validator.value).flatMap(([name, field]) =>
					targetedPlans(field.fieldType, `${path}.${name}`, pinned)
				),
			];
		default:
			return [];
	}
}

export function rowsForTable(validator: ValidatorJSON): JSONValue[] {
	const plans: RowPlan[] = [
		{ allMinimal: true, minimal: NO_PATHS, choices: new Map() },
		{ allMinimal: false, minimal: NO_PATHS, choices: new Map() },
		...targetedPlans(validator, '', new Map()),
	];
	const rows = new Map<string, JSONValue>();
	for (const plan of plans) {
		const row = valueFor(validator, '', plan);
		const key = JSON.stringify(row);
		if (!rows.has(key)) rows.set(key, row);
	}
	return [...rows.values()];
}

/** `row` without the field at `path`, given as segments (see {@link withoutRetiredFields}). */
function withoutField(row: JSONValue, path: readonly string[]): JSONValue {
	const [segment, ...rest] = path;
	if (segment === undefined || row === null || typeof row !== 'object' || Array.isArray(row)) {
		return row;
	}
	const isArray = segment.endsWith('[]');
	const name = isArray ? segment.slice(0, -2) : segment;
	if (!(name in row)) return row;
	if (rest.length === 0) {
		const { [name]: _removed, ...kept } = row;
		return kept;
	}
	const value = row[name] as JSONValue;
	const next =
		isArray && Array.isArray(value)
			? value.map((item) => withoutField(item, rest))
			: withoutField(value, rest);
	return { ...row, [name]: next };
}

/**
 * `row` without the fields at `paths`: `.` between fields, `[]` for every
 * element of an array. How a retired field or argument is read out of what
 * the previous release stored or sent.
 */
export function withoutRetiredFields(row: JSONValue, paths: readonly string[] = []): JSONValue {
	return paths.reduce((current, path) => withoutField(current, path.split('.')), row);
}
