import {
	PLUGIN_CONTRIBUTION_KINDS,
	type PluginCapability,
	type PluginComponentLoader,
	type PluginContributionKind,
	type PluginContributions,
	type PluginFeatureFlagDefinition,
	type PluginLlmBudget,
	type PluginManifest,
} from '@owlat/plugin-kit';
import { PluginHostError } from './errors';

type MutablePluginContributions = {
	-readonly [Kind in PluginContributionKind]?: readonly unknown[];
};

/** Snapshot validated manifest containers without reading through property getters. */
export function snapshotPluginManifest(source: PluginManifest): PluginManifest {
	const pluginId = readRequiredDataProperty<string>(source, 'id', '<unknown>');
	const version = readRequiredDataProperty<string>(source, 'version', pluginId);
	const capabilities = snapshotArray(
		readRequiredDataProperty<readonly PluginCapability[]>(source, 'capabilities', pluginId),
		pluginId,
		'capabilities'
	);
	const contributes = snapshotContributions(
		readOptionalDataProperty<PluginContributions>(source, 'contributes', pluginId),
		pluginId
	);
	const flag = snapshotFlag(
		readOptionalDataProperty<PluginFeatureFlagDefinition>(source, 'flag', pluginId),
		pluginId
	);
	const llmBudget = snapshotLlmBudget(
		readOptionalDataProperty<PluginLlmBudget>(source, 'llmBudget', pluginId),
		pluginId
	);
	const component = readOptionalDataProperty<PluginComponentLoader>(source, 'component', pluginId);

	return Object.freeze({
		id: pluginId,
		version,
		capabilities,
		...(contributes === undefined ? {} : { contributes }),
		...(flag === undefined ? {} : { flag }),
		...(llmBudget === undefined ? {} : { llmBudget }),
		...(component === undefined ? {} : { component }),
	});
}

function snapshotContributions(
	source: PluginContributions | undefined,
	pluginId: string
): PluginContributions | undefined {
	if (source === undefined) return undefined;
	const snapshot: MutablePluginContributions = {};
	for (const kind of PLUGIN_CONTRIBUTION_KINDS) {
		const bucket = readOptionalDataProperty<readonly unknown[]>(source, kind, pluginId);
		if (bucket !== undefined) {
			snapshot[kind] = snapshotArray(bucket, pluginId, `contributes.${kind}`);
		}
	}
	return Object.freeze(snapshot);
}

function snapshotFlag(
	source: PluginFeatureFlagDefinition | undefined,
	pluginId: string
): PluginFeatureFlagDefinition | undefined {
	if (source === undefined) return undefined;
	const defaultValue = readRequiredDataProperty<boolean>(source, 'default', pluginId);
	const requiredEnvVars = readOptionalDataProperty<readonly string[]>(
		source,
		'requiredEnvVars',
		pluginId
	);
	return Object.freeze({
		default: defaultValue,
		...(requiredEnvVars === undefined
			? {}
			: { requiredEnvVars: snapshotArray(requiredEnvVars, pluginId, 'flag.requiredEnvVars') }),
	});
}

function snapshotLlmBudget(
	source: PluginLlmBudget | undefined,
	pluginId: string
): PluginLlmBudget | undefined {
	if (source === undefined) return undefined;
	return Object.freeze({
		dailyUsd: readRequiredDataProperty<number>(source, 'dailyUsd', pluginId),
	});
}

function snapshotArray<Value>(
	source: readonly Value[],
	pluginId: string,
	path: string
): readonly Value[] {
	if (!Array.isArray(source)) return invalidSnapshot(pluginId, path);
	const length = readRequiredDataProperty<number>(source, 'length', pluginId);
	if (!Number.isSafeInteger(length) || length < 0) return invalidSnapshot(pluginId, path);

	const snapshot: Value[] = [];
	for (let index = 0; index < length; index += 1) {
		snapshot.push(readPresentDataProperty<Value>(source, String(index), pluginId));
	}
	return Object.freeze(snapshot);
}

function readRequiredDataProperty<Value>(
	source: object,
	key: PropertyKey,
	pluginId: string
): Value {
	const descriptor = Object.getOwnPropertyDescriptor(source, key);
	if (!descriptor || !('value' in descriptor) || descriptor.value === undefined) {
		return invalidSnapshot(pluginId, String(key));
	}
	return descriptor.value;
}

function readPresentDataProperty<Value>(source: object, key: PropertyKey, pluginId: string): Value {
	const descriptor = Object.getOwnPropertyDescriptor(source, key);
	if (!descriptor || !('value' in descriptor)) {
		return invalidSnapshot(pluginId, String(key));
	}
	return descriptor.value;
}

function readOptionalDataProperty<Value>(
	source: object,
	key: PropertyKey,
	pluginId: string
): Value | undefined {
	const descriptor = Object.getOwnPropertyDescriptor(source, key);
	if (!descriptor) return undefined;
	if (!('value' in descriptor)) return invalidSnapshot(pluginId, String(key));
	return descriptor.value;
}

function invalidSnapshot(pluginId: string, path: string): never {
	throw new PluginHostError(
		'invalid_manifest_snapshot',
		`Plugin ${pluginId} manifest changed while snapshotting ${path}`,
		{ pluginId }
	);
}
