import type { JSONValue, ValidatorJSON } from 'convex/values';

/**
 * Builds rows shaped like the ones a release wrote, straight from that
 * release's table validators. The rows are what an upgraded deployment already
 * has on disk, so the current schema must still accept every one of them.
 *
 * Per table, row 0 carries only the required fields: it catches an optional
 * field that became required. The other rows carry every optional field too,
 * and row n takes the n-th member of every union, so each union member any old
 * row could hold appears at least once: they catch removed fields, changed
 * types and narrowed unions. Values are in Convex's JSON encoding
 * (`convexToJson`), which is how the fixture stores them.
 */

type RowMode = { minimal: boolean; variant: number };

const FIXTURE_STRING = 'fixture';

/** The id format the fixture uses; `validate.ts` reads the table back out of it. */
export function fixtureId(tableName: string): string {
	return `fixture-id:${tableName}`;
}

export function tableNameOfFixtureId(id: string): string | null {
	return id.startsWith('fixture-id:') ? id.slice('fixture-id:'.length) : null;
}

/** The widest union anywhere under `validator`; that many variant rows cover every member. */
function widestUnion(validator: ValidatorJSON): number {
	switch (validator.type) {
		case 'union':
			return Math.max(validator.value.length, ...validator.value.map(widestUnion));
		case 'array':
			return widestUnion(validator.value);
		case 'record':
			return Math.max(widestUnion(validator.keys), widestUnion(validator.values.fieldType));
		case 'object':
			return Math.max(
				1,
				...Object.values(validator.value).map((field) => widestUnion(field.fieldType))
			);
		default:
			return 1;
	}
}

function valueFor(validator: ValidatorJSON, mode: RowMode): JSONValue {
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
			return mode.variant % 2 === 0;
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
			return [valueFor(validator.value, mode)];
		case 'record': {
			const key = valueFor(validator.keys, mode);
			return {
				[typeof key === 'string' ? key : FIXTURE_STRING]: valueFor(
					validator.values.fieldType,
					mode
				),
			};
		}
		case 'union': {
			const member = validator.value[mode.variant % validator.value.length];
			if (!member) throw new Error('empty union in a table validator');
			return valueFor(member, mode);
		}
		case 'object': {
			const row: Record<string, JSONValue> = {};
			for (const [name, field] of Object.entries(validator.value)) {
				if (field.optional && mode.minimal) continue;
				row[name] = valueFor(field.fieldType, mode);
			}
			return row;
		}
	}
}

export function rowsForTable(validator: ValidatorJSON): JSONValue[] {
	const rows = [valueFor(validator, { minimal: true, variant: 0 })];
	const variants = widestUnion(validator);
	for (let variant = 0; variant < variants; variant++) {
		rows.push(valueFor(validator, { minimal: false, variant }));
	}
	return rows;
}
