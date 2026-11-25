/**
 * Read the harness's JSON files (package manifests, the lock the harness itself
 * writes) as checked records rather than typed casts.
 */

import { readFile } from 'node:fs/promises';

export type JsonRecord = Record<string, unknown>;

export function isJsonRecord(value: unknown): value is JsonRecord {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseJsonRecord(source: string, label: string): JsonRecord {
	const value: unknown = JSON.parse(source);
	if (!isJsonRecord(value)) throw new Error(`${label} is not a JSON object`);
	return value;
}

export async function readJsonRecord(path: string): Promise<JsonRecord> {
	return parseJsonRecord(await readFile(path, 'utf8'), path);
}

export function recordField(record: JsonRecord, key: string, label: string): JsonRecord {
	const value = record[key];
	if (!isJsonRecord(value)) throw new Error(`${label}.${key} is not an object`);
	return value;
}

export function stringField(record: JsonRecord, key: string, label: string): string {
	const value = record[key];
	if (typeof value !== 'string') throw new Error(`${label}.${key} is not a string`);
	return value;
}

/** A `{ name: range }` map such as `dependencies`, or an empty one when absent. */
export function stringMap(record: JsonRecord, key: string, label: string): Record<string, string> {
	const value = record[key];
	if (value === undefined) return {};
	if (!isJsonRecord(value)) throw new Error(`${label}.${key} is not an object`);
	const map: Record<string, string> = {};
	for (const [name, entry] of Object.entries(value)) {
		if (typeof entry !== 'string') throw new Error(`${label}.${key}.${name} is not a string`);
		map[name] = entry;
	}
	return map;
}
