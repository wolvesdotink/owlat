import type {
	FeatureFlagKey,
	PluginFeatureFlagDefinition,
	PluginFeatureFlagKey,
} from './featureFlags';

export const MAX_PLUGIN_FEATURE_FLAGS = 128;
export const INVALID_PLUGIN_FEATURE_FLAG_DEFINITION = 'Invalid plugin feature flag definition';

// Plugin manifests use the same 64-item ceilings for capabilities and required
// environment variables. Applying that ceiling to every definition array keeps
// this secondary runtime boundary predictably bounded too.
const MAX_DEFINITION_ARRAY_ITEMS = 64;
const PLUGIN_FLAG_KEY = /^plugin\.[a-z][a-z0-9-]{0,63}$/;
const STRING_ARRAY_FIELDS = [
	'requires',
	'cascadesOff',
	'requiredEnvVars',
	'dockerProfiles',
	'requiredCapabilities',
] as const;
type StringArrayField = (typeof STRING_ARRAY_FIELDS)[number];

const DEFINITION_FIELDS = new Set<PropertyKey>([
	'key',
	'category',
	'label',
	'description',
	'default',
	...STRING_ARRAY_FIELDS,
	'hostedOnly',
	'pluginPackageName',
]);

export type PluginDefinitionArraySnapshot =
	| { readonly kind: 'valid'; readonly value: readonly unknown[] }
	| { readonly kind: 'invalid' | 'too_many' };

type DenseArraySnapshot<T> =
	| { readonly kind: 'valid'; readonly value: readonly T[] }
	| { readonly kind: 'invalid' | 'too_many' };

type ItemSnapshot<T> = { readonly valid: true; readonly value: T } | { readonly valid: false };

/** Capture the untrusted definition list without reading indexed properties. */
export function capturePluginDefinitionArray(value: unknown): PluginDefinitionArraySnapshot {
	try {
		return snapshotDenseDataArray(value, MAX_PLUGIN_FEATURE_FLAGS, (item) => ({
			valid: true,
			value: item,
		}));
	} catch {
		return { kind: 'invalid' };
	}
}

/** Validate and normalize one definition without invoking any of its getters. */
export function snapshotPluginFeatureFlagDefinition(
	value: unknown
): Readonly<PluginFeatureFlagDefinition> | undefined {
	try {
		if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
		const captured = captureDefinitionProperties(value);
		if (!captured) return undefined;

		const key = captured['key'];
		const category = captured['category'];
		const label = captured['label'];
		const description = captured['description'];
		const defaultValue = captured['default'];
		const hostedOnly = captured['hostedOnly'];
		const pluginPackageName = captured['pluginPackageName'];
		if (
			typeof key !== 'string' ||
			!PLUGIN_FLAG_KEY.test(key) ||
			category !== 'plugins' ||
			typeof label !== 'string' ||
			typeof description !== 'string' ||
			typeof defaultValue !== 'boolean' ||
			(hostedOnly !== undefined && typeof hostedOnly !== 'boolean') ||
			typeof pluginPackageName !== 'string' ||
			pluginPackageName.length === 0
		) {
			return undefined;
		}

		const arrays = Object.create(null) as Record<StringArrayField, readonly string[] | undefined>;
		for (const field of STRING_ARRAY_FIELDS) {
			const fieldValue = captured[field];
			if (fieldValue === undefined && field !== 'requiredCapabilities') {
				arrays[field] = undefined;
				continue;
			}
			const snapshot = snapshotDenseDataArray(
				fieldValue,
				MAX_DEFINITION_ARRAY_ITEMS,
				(item): ItemSnapshot<string> =>
					typeof item === 'string' ? { valid: true, value: item } : { valid: false }
			);
			if (snapshot.kind !== 'valid') return undefined;
			arrays[field] = snapshot.value;
		}

		return Object.freeze({
			key: key as PluginFeatureFlagKey,
			category,
			label,
			description,
			default: defaultValue,
			requires: arrays.requires as readonly FeatureFlagKey[] | undefined,
			cascadesOff: arrays.cascadesOff as readonly FeatureFlagKey[] | undefined,
			requiredEnvVars: arrays.requiredEnvVars,
			dockerProfiles: arrays.dockerProfiles,
			hostedOnly,
			requiredCapabilities: arrays.requiredCapabilities!,
			pluginPackageName,
		});
	} catch {
		return undefined;
	}
}

export function isPluginFeatureFlagDefinition(
	value: unknown
): value is PluginFeatureFlagDefinition {
	return snapshotPluginFeatureFlagDefinition(value) !== undefined;
}

function captureDefinitionProperties(value: object): Readonly<Record<string, unknown>> | undefined {
	const keys = Reflect.ownKeys(value);
	if (keys.length > DEFINITION_FIELDS.size) return undefined;

	const captured = Object.create(null) as Record<string, unknown>;
	for (const key of keys) {
		if (typeof key !== 'string' || !DEFINITION_FIELDS.has(key)) return undefined;
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor || !('value' in descriptor)) return undefined;
		captured[key] = descriptor.value;
	}
	return captured;
}

function snapshotDenseDataArray<T>(
	value: unknown,
	maximumItems: number,
	snapshotItem: (item: unknown, index: number) => ItemSnapshot<T>
): DenseArraySnapshot<T> {
	if (!Array.isArray(value)) return { kind: 'invalid' };
	const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
	if (!lengthDescriptor || !('value' in lengthDescriptor)) return { kind: 'invalid' };
	const length = lengthDescriptor.value;
	if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) {
		return { kind: 'invalid' };
	}
	if (length > maximumItems) return { kind: 'too_many' };

	const allowedKeys = new Set<string>(['length']);
	for (let index = 0; index < length; index += 1) allowedKeys.add(String(index));
	const ownKeys = Reflect.ownKeys(value);
	if (ownKeys.length !== allowedKeys.size) return { kind: 'invalid' };
	for (const key of ownKeys) {
		if (typeof key !== 'string' || !allowedKeys.has(key)) return { kind: 'invalid' };
	}

	const snapshot: T[] = [];
	for (let index = 0; index < length; index += 1) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		if (!descriptor || !('value' in descriptor)) return { kind: 'invalid' };
		const item = snapshotItem(descriptor.value, index);
		if (!item.valid) return { kind: 'invalid' };
		snapshot.push(item.value);
	}
	return { kind: 'valid', value: Object.freeze(snapshot) };
}
