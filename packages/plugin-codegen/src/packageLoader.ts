import { pathToFileURL } from 'node:url';
import {
	composeValidatedBundledPlugins,
	parsePluginPackageName,
	PluginCompositionError,
	type BundledPlugin,
	type ValidatedBundledPluginSource,
} from '@owlat/plugin-host';
import { parsePluginManifest } from '@owlat/plugin-kit';
import { PluginCodegenError } from './errors';
import { resolveVerifiedPluginEntry } from './packageProvenance';

type LoadModule = (resolvedEntry: string) => Promise<unknown>;

export interface PackageLoadingOptions {
	readonly loadModule?: LoadModule;
}

export async function loadBundledPlugins(
	workspaceRoot: string,
	packageNames: readonly string[],
	options: PackageLoadingOptions = {}
): Promise<readonly BundledPlugin[]> {
	const loadModule = options.loadModule ?? importModule;
	const sources: ValidatedBundledPluginSource[] = [];

	for (const packageNameInput of packageNames) {
		let packageName;
		try {
			packageName = parsePluginPackageName(packageNameInput);
		} catch (cause) {
			throw new PluginCodegenError(
				'dependency_provenance',
				'Bundled plugin configuration contains an invalid package name',
				[],
				{ cause }
			);
		}
		const resolvedEntry = await resolveVerifiedPluginEntry(workspaceRoot, packageName);

		let loadedModule: unknown;
		try {
			loadedModule = await loadModule(resolvedEntry);
		} catch (cause) {
			throw new PluginCodegenError(
				'package_load_failed',
				`Bundled plugin ${packageName} could not be imported`,
				[],
				{ cause }
			);
		}

		let manifest;
		try {
			manifest = parsePluginManifest(readDefaultExport(loadedModule));
		} catch (cause) {
			throw new PluginCodegenError(
				'invalid_manifest',
				`Bundled plugin ${packageName} does not export a valid default manifest`,
				[],
				{ cause }
			);
		}
		sources.push({ packageName, manifest });
	}

	try {
		return composeValidatedBundledPlugins(sources);
	} catch (cause) {
		if (cause instanceof PluginCompositionError) {
			throw new PluginCodegenError('composition_invalid', cause.message, [], { cause });
		}
		throw cause;
	}
}

function readDefaultExport(loadedModule: unknown): unknown {
	if (!isRecord(loadedModule)) return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(loadedModule, 'default');
	return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function importModule(resolvedEntry: string): Promise<unknown> {
	return import(pathToFileURL(resolvedEntry).href);
}
