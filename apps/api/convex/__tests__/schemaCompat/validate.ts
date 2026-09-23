import { convexToJson, jsonToConvex, type JSONValue, type ValidatorJSON } from 'convex/values';
import { tableNameOfFixtureId } from './rows';

/**
 * Checks one stored row against a table validator the way the deployment's
 * schema validation does, and says where it breaks. convex-test's own check
 * skips record validators and cannot tell which table a hand-built id points
 * at, so it is not reused here.
 *
 * Returns null when the row validates, otherwise the path and reason of the
 * first mismatch.
 */
export function schemaMismatch(validator: ValidatorJSON, row: JSONValue): string | null {
	return mismatch(validator, jsonToConvex(row), '');
}

function describe(value: unknown): string {
	if (typeof value === 'bigint') return `${value}n`;
	if (value instanceof ArrayBuffer) return 'bytes';
	return JSON.stringify(value) ?? String(value);
}

function mismatch(validator: ValidatorJSON, value: unknown, path: string): string | null {
	const at = path || '(row)';
	const expected = (what: string) => `${at}: expected ${what}, got ${describe(value)}`;
	switch (validator.type) {
		case 'null':
			return value === null ? null : expected('null');
		case 'number':
			return typeof value === 'number' ? null : expected('number');
		case 'bigint':
		case 'commitTs':
			return typeof value === 'bigint' ? null : expected('int64');
		case 'boolean':
			return typeof value === 'boolean' ? null : expected('boolean');
		case 'string':
			return typeof value === 'string' ? null : expected('string');
		case 'bytes':
			return value instanceof ArrayBuffer ? null : expected('bytes');
		case 'any':
			return null;
		case 'literal':
			return JSON.stringify(convexToJson(value as never)) === JSON.stringify(validator.value)
				? null
				: expected(`literal ${JSON.stringify(validator.value)}`);
		case 'id': {
			if (typeof value !== 'string') return expected(`id of ${validator.tableName}`);
			const table = tableNameOfFixtureId(value);
			return table === null || table === validator.tableName
				? null
				: expected(`id of ${validator.tableName}`);
		}
		case 'array': {
			if (!Array.isArray(value)) return expected('array');
			for (const [index, item] of value.entries()) {
				const problem = mismatch(validator.value, item, `${path}[${index}]`);
				if (problem) return problem;
			}
			return null;
		}
		case 'record': {
			if (!isPlainObject(value)) return expected('record');
			for (const [key, item] of Object.entries(value)) {
				const keyProblem = mismatch(validator.keys, key, `${path}{key ${key}}`);
				if (keyProblem) return keyProblem;
				const problem = mismatch(validator.values.fieldType, item, `${path}.${key}`);
				if (problem) return problem;
			}
			return null;
		}
		case 'union': {
			if (validator.value.some((member) => mismatch(member, value, path) === null)) return null;
			const members = validator.value.map((member) =>
				member.type === 'literal' ? JSON.stringify(member.value) : member.type
			);
			return expected(`one of ${members.join(' | ')}`);
		}
		case 'object': {
			if (!isPlainObject(value)) return expected('object');
			for (const [name, field] of Object.entries(validator.value)) {
				const fieldPath = path ? `${path}.${name}` : name;
				if (value[name] === undefined) {
					if (!field.optional) return `${fieldPath}: required field missing`;
					continue;
				}
				const problem = mismatch(field.fieldType, value[name], fieldPath);
				if (problem) return problem;
			}
			for (const name of Object.keys(value)) {
				if (!(name in validator.value)) {
					return `${path ? `${path}.${name}` : name}: field is no longer in the schema`;
				}
			}
			return null;
		}
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === 'object' &&
		value !== null &&
		!Array.isArray(value) &&
		!(value instanceof ArrayBuffer)
	);
}
