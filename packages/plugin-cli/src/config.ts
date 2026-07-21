import { join } from 'node:path';
import {
	BoundedRepositoryFileError,
	MAX_PLUGIN_CONFIG_BYTES,
	parsePluginsConfig,
	PluginCodegenError,
	readBoundedRepositoryUtf8File,
	writeFileAtomically,
} from '@owlat/plugin-codegen';
import { parsePluginPackageName, type PluginPackageName } from '@owlat/plugin-host';
import { PluginCliError } from './errors';

/** The single checked-in composition point every CLI command reads and rewrites. */
export const CONFIG_PATH = 'plugins.config.ts';

const CONFIG_IMPORT = "import type { PluginsConfig } from '@owlat/plugin-codegen';";
const PROPERTY_PREFIX = 'bundledPluginPackages: ';
// oxfmt renders the checked-in config with tabs (width 2) and a 100-column
// print width; the canonical serializer matches that layout so a config an
// operator edits with the CLI stays formatter-clean without re-running oxfmt.
const TAB_WIDTH = 2;
const PRINT_WIDTH = 100;

export interface PluginsConfigState {
	/** The exact bytes currently on disk, so a no-op edit can be detected precisely. */
	readonly source: string;
	/** Bundled plugin package names in their on-disk order. */
	readonly packages: readonly PluginPackageName[];
}

/** Read and statically parse plugins.config.ts without evaluating it as code. */
export async function readPluginsConfig(workspaceRoot: string): Promise<PluginsConfigState> {
	let source: string;
	try {
		source = await readBoundedRepositoryUtf8File(
			workspaceRoot,
			join(workspaceRoot, CONFIG_PATH),
			MAX_PLUGIN_CONFIG_BYTES
		);
	} catch (cause) {
		if (cause instanceof BoundedRepositoryFileError) {
			throw new PluginCliError(
				`Cannot read ${CONFIG_PATH}: it must be a workspace-relative UTF-8 file no larger than ${MAX_PLUGIN_CONFIG_BYTES} bytes`,
				[],
				{ cause }
			);
		}
		throw new PluginCliError(`Cannot read ${CONFIG_PATH}`, [], { cause });
	}

	try {
		const parsed = parsePluginsConfig(source, join(workspaceRoot, CONFIG_PATH));
		return { source, packages: parsed.bundledPluginPackages };
	} catch (cause) {
		if (cause instanceof PluginCodegenError) {
			throw new PluginCliError(cause.message, cause.details, { cause });
		}
		throw cause;
	}
}

/** Validate one operator-supplied package-name argument up front, before any edit. */
export function parsePackageArgument(input: string): PluginPackageName {
	try {
		return parsePluginPackageName(input);
	} catch (cause) {
		throw new PluginCliError(
			`"${input}" is not a valid bundled plugin package name (expected a lowercase npm package name without a subpath)`,
			[],
			{ cause }
		);
	}
}

export interface ConfigEdit {
	readonly packages: readonly PluginPackageName[];
	/** True when the edit changes the set of bundled packages. */
	readonly changed: boolean;
}

/** Add a package, preserving on-disk order and treating an already-listed package as a no-op. */
export function addPackage(
	packages: readonly PluginPackageName[],
	packageName: PluginPackageName
): ConfigEdit {
	if (packages.includes(packageName)) return { packages, changed: false };
	return { packages: [...packages, packageName], changed: true };
}

/** Remove a package, treating an absent package as a no-op. */
export function removePackage(
	packages: readonly PluginPackageName[],
	packageName: PluginPackageName
): ConfigEdit {
	if (!packages.includes(packageName)) return { packages, changed: false };
	return { packages: packages.filter((name) => name !== packageName), changed: true };
}

/** Render the canonical, formatter-clean plugins.config.ts for a package list. */
export function serializePluginsConfig(packages: readonly PluginPackageName[]): string {
	return [
		CONFIG_IMPORT,
		'',
		'export default {',
		`\t${PROPERTY_PREFIX}${formatPackageArray(packages)},`,
		'} satisfies PluginsConfig;',
		'',
	].join('\n');
}

function formatPackageArray(packages: readonly PluginPackageName[]): string {
	if (packages.length === 0) return '[]';
	const inline = `[${packages.map((name) => `'${name}'`).join(', ')}]`;
	const inlineWidth = TAB_WIDTH + PROPERTY_PREFIX.length + inline.length + ','.length;
	if (inlineWidth <= PRINT_WIDTH) return inline;
	const lines = packages.map((name) => `\t\t'${name}',`);
	return ['[', ...lines, '\t]'].join('\n');
}

/**
 * Serialize the package list and write it atomically. The config file is a
 * checked-in source file rather than generated output, so a filesystem-safety
 * failure from the shared atomic writer is re-surfaced with config-appropriate,
 * actionable wording rather than the writer's generated-composition phrasing.
 */
export async function writePluginsConfig(
	workspaceRoot: string,
	packages: readonly PluginPackageName[]
): Promise<void> {
	const source = serializePluginsConfig(packages);
	try {
		await writeFileAtomically(workspaceRoot, join(workspaceRoot, CONFIG_PATH), source);
	} catch (cause) {
		if (cause instanceof PluginCodegenError) {
			throw new PluginCliError(
				`Cannot safely write ${CONFIG_PATH}: ${cause.message}`,
				['plugins.config.ts was left unchanged; resolve the filesystem issue and retry.'],
				{ cause }
			);
		}
		throw cause;
	}
}
