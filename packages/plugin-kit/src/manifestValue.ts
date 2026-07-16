import { addManifestIssue, type PluginManifestIssue } from './manifestIssues';
import { INVALID_SCHEMA_ARRAY } from './manifestSnapshot';

export type DataProperty =
	| { readonly kind: 'missing' | 'accessor' }
	| { readonly kind: 'value'; readonly value: unknown };

export function readDataProperty(
	value: Record<string, unknown>,
	key: string,
	issues: PluginManifestIssue[],
	required = false,
	parentPath = '$'
): DataProperty {
	const path = /^(0|[1-9]\d*)$/.test(key) ? `${parentPath}[${key}]` : `${parentPath}.${key}`;
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	if (!descriptor) {
		if (required) addManifestIssue(issues, 'missing', path, 'is required');
		return { kind: 'missing' };
	}
	if (!('value' in descriptor)) {
		addManifestIssue(issues, 'accessor_not_allowed', path, 'must be a data property');
		return { kind: 'accessor' };
	}
	return { kind: 'value', value: descriptor.value };
}

export function validateKnownFields(
	value: Record<string, unknown>,
	path: string,
	knownFields: ReadonlySet<string>,
	issues: PluginManifestIssue[]
): void {
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== 'string') {
			addManifestIssue(
				issues,
				'unknown_field',
				`${path}[${String(key)}]`,
				'symbol fields are not supported'
			);
		} else if (!knownFields.has(key)) {
			addManifestIssue(issues, 'unknown_field', `${path}.${key}`, 'is not supported');
		}
	}
}

export function validateDescriptorSafeArray(
	value: unknown,
	path: string,
	issues: PluginManifestIssue[]
): readonly DataProperty[] | undefined {
	if (value === INVALID_SCHEMA_ARRAY) return undefined;
	if (!Array.isArray(value)) {
		addManifestIssue(issues, 'invalid_type', path, 'must be an array');
		return undefined;
	}
	const length = readDataProperty(
		value as unknown as Record<string, unknown>,
		'length',
		issues,
		true,
		path
	);
	if (
		length.kind !== 'value' ||
		typeof length.value !== 'number' ||
		!Number.isSafeInteger(length.value) ||
		length.value < 0
	) {
		if (length.kind === 'value') {
			addManifestIssue(issues, 'invalid_type', `${path}.length`, 'must be a valid array length');
		}
		return undefined;
	}

	const allowedKeys = new Set<string>(['length']);
	for (let index = 0; index < length.value; index += 1) allowedKeys.add(String(index));
	validateKnownFields(value as unknown as Record<string, unknown>, path, allowedKeys, issues);

	const items: DataProperty[] = [];
	for (let index = 0; index < length.value; index += 1) {
		const item = readDataProperty(
			value as unknown as Record<string, unknown>,
			String(index),
			issues,
			true,
			path
		);
		if (item.kind !== 'value') return undefined;
		items.push(item);
	}
	return items;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
