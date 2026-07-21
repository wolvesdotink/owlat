import type { JsonValue } from '@owlat/plugin-kit';
import { CURRENT_PLUGIN_STORAGE_VALUE_JSON_VERSION } from '../lib/constants';

export const PLUGIN_STORAGE_LIMITS = Object.freeze({
	maxKeyBytes: 256,
	maxValueBytes: 64 * 1024,
	maxEntries: 1_000,
	maxTotalBytes: 10 * 1024 * 1024,
	maxListPageSize: 100,
	maxJsonDepth: 32,
	maxJsonNodes: 4_096,
	maxArrayItems: 1_024,
	maxObjectFields: 1_024,
});

export interface EncodedPluginStorageValue {
	readonly json: string;
	readonly version: typeof CURRENT_PLUGIN_STORAGE_VALUE_JSON_VERSION;
	readonly bytes: number;
}

export class InvalidPluginStorageValueError extends TypeError {
	constructor() {
		super('Plugin storage value must be bounded JSON');
		this.name = 'InvalidPluginStorageValueError';
	}
}

/** Snapshot and canonicalize unknown input without evaluating accessor values. */
export function encodePluginStorageValue(value: unknown): EncodedPluginStorageValue {
	try {
		const state = { nodes: 0 };
		const json = encodeValue(value, 0, state);
		const bytes = utf8Bytes(json);
		if (bytes > PLUGIN_STORAGE_LIMITS.maxValueBytes) throw new InvalidPluginStorageValueError();
		return Object.freeze({
			json,
			version: CURRENT_PLUGIN_STORAGE_VALUE_JSON_VERSION,
			bytes,
		});
	} catch (error) {
		if (error instanceof InvalidPluginStorageValueError) throw error;
		throw new InvalidPluginStorageValueError();
	}
}

export function decodePluginStorageValue(json: string, version: number | undefined): JsonValue {
	if (version !== CURRENT_PLUGIN_STORAGE_VALUE_JSON_VERSION) {
		throw new InvalidPluginStorageValueError();
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		throw new InvalidPluginStorageValueError();
	}
	const encoded = encodePluginStorageValue(parsed);
	if (encoded.json !== json) throw new InvalidPluginStorageValueError();
	return parsed as JsonValue;
}

export function validatePluginStorageKey(key: unknown): string {
	if (
		typeof key !== 'string' ||
		key.length === 0 ||
		key.includes('\0') ||
		hasUnpairedSurrogate(key) ||
		utf8Bytes(key) > PLUGIN_STORAGE_LIMITS.maxKeyBytes
	) {
		throw new TypeError('Invalid plugin storage key');
	}
	return key;
}

/** All tenant-controlled persisted payload charged to the total-byte quota. */
export function pluginStorageEntryBytes(key: string, valueBytes: number): number {
	return utf8Bytes(validatePluginStorageKey(key)) + valueBytes;
}

function encodeValue(value: unknown, depth: number, state: { nodes: number }): string {
	state.nodes += 1;
	if (
		state.nodes > PLUGIN_STORAGE_LIMITS.maxJsonNodes ||
		depth > PLUGIN_STORAGE_LIMITS.maxJsonDepth
	) {
		throw new InvalidPluginStorageValueError();
	}
	if (value === null || typeof value === 'boolean') return JSON.stringify(value);
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) throw new InvalidPluginStorageValueError();
		return JSON.stringify(Object.is(value, -0) ? 0 : value);
	}
	if (typeof value === 'string') {
		if (hasUnpairedSurrogate(value)) throw new InvalidPluginStorageValueError();
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return encodeArray(value, depth, state);
	if (isPlainObject(value)) return encodeObject(value, depth, state);
	throw new InvalidPluginStorageValueError();
}

function encodeArray(value: readonly unknown[], depth: number, state: { nodes: number }): string {
	if (value.length > PLUGIN_STORAGE_LIMITS.maxArrayItems) {
		throw new InvalidPluginStorageValueError();
	}
	const keys = Reflect.ownKeys(value);
	if (keys.length !== value.length + 1 || keys.some((key) => typeof key === 'symbol')) {
		throw new InvalidPluginStorageValueError();
	}
	const items: string[] = [];
	for (let index = 0; index < value.length; index += 1) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
			throw new InvalidPluginStorageValueError();
		}
		items.push(encodeValue(descriptor.value, depth + 1, state));
	}
	return `[${items.join(',')}]`;
}

function encodeObject(
	value: Record<string, unknown>,
	depth: number,
	state: { nodes: number }
): string {
	const keys = Reflect.ownKeys(value);
	if (
		keys.length > PLUGIN_STORAGE_LIMITS.maxObjectFields ||
		keys.some((key) => typeof key === 'symbol')
	) {
		throw new InvalidPluginStorageValueError();
	}
	const stringKeys = keys as string[];
	stringKeys.sort(compareUtf16CodeUnits);
	const fields: string[] = [];
	for (const key of stringKeys) {
		if (hasUnpairedSurrogate(key)) throw new InvalidPluginStorageValueError();
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
			throw new InvalidPluginStorageValueError();
		}
		fields.push(`${JSON.stringify(key)}:${encodeValue(descriptor.value, depth + 1, state)}`);
	}
	return `{${fields.join(',')}}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== 'object') return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/** Match JavaScript/JSON's deterministic lexicographic UTF-16 code-unit order. */
function compareUtf16CodeUnits(left: string, right: string): number {
	return left === right ? 0 : left < right ? -1 : 1;
}

function utf8Bytes(value: string): number {
	return new TextEncoder().encode(value).length;
}

function hasUnpairedSurrogate(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (!Number.isFinite(next) || next < 0xdc00 || next > 0xdfff) return true;
			index += 1;
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			return true;
		}
	}
	return false;
}
