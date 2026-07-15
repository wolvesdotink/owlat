import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import {
	composeBundledPlugins,
	PluginCompositionError,
	type BundledPlugin,
} from '@owlat/plugin-host';
import { parsePluginManifest } from '@owlat/plugin-kit';
import { PluginCodegenError } from './errors';

interface WorkspacePackageJson {
	readonly dependencies?: Record<string, unknown>;
	readonly optionalDependencies?: Record<string, unknown>;
}

type ResolvePackage = (packageName: string, workspaceRoot: string) => string;
type LoadModule = (resolvedEntry: string) => Promise<unknown>;

export interface PackageLoadingOptions {
	readonly resolvePackage?: ResolvePackage;
	readonly loadModule?: LoadModule;
}

export async function loadBundledPlugins(
	workspaceRoot: string,
	packageNames: readonly string[],
	options: PackageLoadingOptions = {}
): Promise<readonly BundledPlugin[]> {
	const workspacePackageJson = await readWorkspacePackageJson(workspaceRoot);
	const resolvePackage = options.resolvePackage ?? resolvePackageWithBun;
	const loadModule = options.loadModule ?? importModule;
	const sources = [];

	for (const packageName of packageNames) {
		if (!isProductionDependency(workspacePackageJson, packageName)) {
			throw new PluginCodegenError(
				'dependency_missing',
				`Bundled plugin ${packageName} must be installed as a root dependency or optionalDependency`
			);
		}

		let resolvedEntry: string;
		try {
			resolvedEntry = resolvePackage(packageName, workspaceRoot);
		} catch (cause) {
			throw new PluginCodegenError(
				'dependency_missing',
				`Bundled plugin ${packageName} is declared but not installed`,
				[],
				{ cause }
			);
		}

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

		const manifest = readDefaultExport(loadedModule);
		try {
			parsePluginManifest(manifest);
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
		return composeBundledPlugins(sources);
	} catch (cause) {
		if (cause instanceof PluginCompositionError) {
			throw new PluginCodegenError('composition_invalid', cause.message, [], { cause });
		}
		throw cause;
	}
}

/** Match the ESM import condition used by the generated Convex and Nuxt modules. */
export function resolvePackageWithBun(packageName: string, workspaceRoot: string): string {
	const bun = (
		globalThis as typeof globalThis & {
			Bun?: { resolveSync(specifier: string, parent: string): string };
		}
	).Bun;
	if (!bun) {
		throw new PluginCodegenError('workspace_not_found', 'Bundled plugin codegen must run with Bun');
	}
	return bun.resolveSync(packageName, workspaceRoot);
}

async function readWorkspacePackageJson(workspaceRoot: string): Promise<WorkspacePackageJson> {
	try {
		const source = await readFile(join(workspaceRoot, 'package.json'), 'utf8');
		const value: unknown = JSON.parse(source);
		if (!isRecord(value)) throw new Error('package.json must contain an object');
		return value as WorkspacePackageJson;
	} catch (cause) {
		throw new PluginCodegenError(
			'workspace_not_found',
			'Cannot read the workspace package.json',
			[],
			{ cause }
		);
	}
}

function isProductionDependency(packageJson: WorkspacePackageJson, packageName: string): boolean {
	return (
		Object.hasOwn(packageJson.dependencies ?? {}, packageName) ||
		Object.hasOwn(packageJson.optionalDependencies ?? {}, packageName)
	);
}

function readDefaultExport(loadedModule: unknown): unknown {
	if (!isRecord(loadedModule) || !Object.hasOwn(loadedModule, 'default')) return undefined;
	return loadedModule['default'];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function importModule(resolvedEntry: string): Promise<unknown> {
	return import(pathToFileURL(resolvedEntry).href);
}
