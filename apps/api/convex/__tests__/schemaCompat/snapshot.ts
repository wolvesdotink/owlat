import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ValidatorJSON } from 'convex/values';
import type { FunctionSignature } from './functions';

/**
 * `previousRelease.json` holds the table validators of the last release, as
 * `defineSchema` exported them, and the signatures of the functions that
 * release's callers reach (see `functions.ts`). The compat tests build rows and
 * calls from them, so the fixture stays a plain snapshot: refreshing it at a
 * release shows that release's schema and argument changes as an ordinary
 * diff, one field or function per line.
 */

export type SchemaSnapshot = {
	release: string;
	commit: string;
	tables: Record<string, ValidatorJSON>;
	functions: Record<string, FunctionSignature>;
};

export const SNAPSHOT_PATH = resolve(import.meta.dirname, 'previousRelease.json');

export function readSnapshot(): SchemaSnapshot {
	return JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as SchemaSnapshot;
}

/** Valid JSON, laid out so each table field and each function is its own line. */
export function writeSnapshot(snapshot: SchemaSnapshot): void {
	const tables = Object.keys(snapshot.tables)
		.sort()
		.map((name) => {
			const validator = snapshot.tables[name];
			if (validator?.type !== 'object')
				return `\t\t${JSON.stringify(name)}: ${JSON.stringify(validator)}`;
			const fields = Object.keys(validator.value)
				.sort()
				.map(
					(field) => `\t\t\t${JSON.stringify(field)}: ${JSON.stringify(validator.value[field])}`
				);
			return [
				`\t\t${JSON.stringify(name)}: {"type": "object", "value": {`,
				fields.join(',\n'),
				'\t\t}}',
			].join('\n');
		});
	const functions = Object.keys(snapshot.functions)
		.sort()
		.map((path) => `\t\t${JSON.stringify(path)}: ${JSON.stringify(snapshot.functions[path])}`);
	const body = [
		'{',
		`\t"release": ${JSON.stringify(snapshot.release)},`,
		`\t"commit": ${JSON.stringify(snapshot.commit)},`,
		'\t"tables": {',
		tables.join(',\n'),
		'\t},',
		'\t"functions": {',
		functions.join(',\n'),
		'\t}',
		'}',
		'',
	].join('\n');
	writeFileSync(SNAPSHOT_PATH, body);
}
