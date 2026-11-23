import { pathToFileURL } from 'node:url';
import {
	composeValidatedBundledPlugins,
	parsePluginPackageName,
	PluginCompositionError,
	type BundledPlugin,
	type ValidatedBundledPluginSource,
} from '@owlat/plugin-host';
import {
	parsePluginManifest,
	PluginManifestError,
	pluginContributionModules,
} from '@owlat/plugin-kit';
import { isRecord } from '@owlat/shared';
import { PluginCodegenError } from './errors';
import {
	resolveVerifiedPluginEntry,
	verifyPluginComponentExport,
	verifyPluginContributionExport,
} from './packageProvenance';

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
				[describeImportFailure(cause)],
				{ cause }
			);
		}

		let manifest;
		const defaultExport = readDefaultExport(loadedModule);
		try {
			manifest = parsePluginManifest(defaultExport);
		} catch (cause) {
			throw new PluginCodegenError(
				'invalid_manifest',
				`Bundled plugin ${packageName} does not export a valid default manifest`,
				defaultExport === undefined
					? [describeMissingDefault(loadedModule)]
					: cause instanceof PluginManifestError
						? cause.issues.map((issue) => `${issue.path} ${issue.message}`)
						: [],
				{ cause }
			);
		}
		if (manifest.component) {
			await verifyPluginComponentExport(workspaceRoot, packageName, manifest.component.exportPath);
		}
		// EVERY declared executable half is provenance-verified, found structurally
		// rather than by listing the buckets that ship one. Per-bucket loops here
		// let crons and the three automation registries reach generated Convex
		// imports unverified when later pieces added them.
		for (const contributed of pluginContributionModules(manifest)) {
			await verifyPluginContributionExport(workspaceRoot, packageName, contributed.exportPath);
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

const MAX_CAUSE_LENGTH = 300;

/**
 * The first line of what the import threw, bounded. A plugin's own top-level
 * code produced it, so it is the author's diagnosis; the stack and any later
 * lines stay out because they can carry paths and values from the build host.
 */
function describeImportFailure(cause: unknown): string {
	if (!(cause instanceof Error)) return 'The import threw a non-Error value';
	const firstLine = cause.message.split('\n', 1)[0]?.trim() ?? '';
	const text = firstLine.length > 0 ? `${cause.name}: ${firstLine}` : cause.name;
	return text.length > MAX_CAUSE_LENGTH ? `${text.slice(0, MAX_CAUSE_LENGTH)}…` : text;
}

/**
 * Names only the module's export KEYS: reading their values could run an
 * accessor, which the loader never does.
 */
function describeMissingDefault(loadedModule: unknown): string {
	const names = isRecord(loadedModule)
		? Object.keys(loadedModule).filter((name) => name !== 'default')
		: [];
	const shown = names.slice(0, 10).join(', ');
	const more = names.length > 10 ? `, and ${names.length - 10} more` : '';
	return names.length === 0
		? 'The root module has no default export and no named exports'
		: `The root module has no default export. Its named exports are: ${shown}${more}`;
}

async function importModule(resolvedEntry: string): Promise<unknown> {
	return import(pathToFileURL(resolvedEntry).href);
}
