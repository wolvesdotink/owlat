import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { parsePluginsConfig } from './config';
import { PluginCodegenError } from './errors';
import { checkDirectPluginImports } from './packageBoundaries';
import { loadBundledPlugins } from './packageLoader';
import { renderPluginComposition } from './render';

const CONFIG_PATH = 'plugins.config.ts';
const CONVEX_OUTPUT_PATH = 'apps/api/convex/plugins/plugins.generated.ts';
const NUXT_OUTPUT_PATH = 'apps/web/app/plugins/plugin-composition.generated.ts';

export interface GeneratePluginCompositionOptions {
	readonly check?: boolean;
	readonly boundariesOnly?: boolean;
}

export async function generatePluginComposition(
	workspaceRoot: string,
	options: GeneratePluginCompositionOptions = {}
): Promise<void> {
	const configSource = await readConfig(workspaceRoot);
	const config = parsePluginsConfig(configSource, join(workspaceRoot, CONFIG_PATH));
	await checkDirectPluginImports(workspaceRoot, config.bundledPluginPackages);
	if (options.boundariesOnly) return;

	const plugins = await loadBundledPlugins(workspaceRoot, config.bundledPluginPackages);
	const generated = renderPluginComposition(plugins);
	const targets = [
		{ path: join(workspaceRoot, CONVEX_OUTPUT_PATH), source: generated.convex },
		{ path: join(workspaceRoot, NUXT_OUTPUT_PATH), source: generated.nuxt },
	] as const;

	if (options.check) {
		const staleFiles: string[] = [];
		for (const target of targets) {
			if ((await readExistingFile(target.path)) !== target.source) {
				staleFiles.push(relative(workspaceRoot, target.path));
			}
		}
		if (staleFiles.length > 0) {
			throw new PluginCodegenError(
				'generated_files_stale',
				'Bundled plugin composition is stale; run bun run plugins:codegen',
				staleFiles
			);
		}
		return;
	}

	for (const target of targets) await writeFileAtomically(target.path, target.source);
}

async function readConfig(workspaceRoot: string): Promise<string> {
	try {
		return await readFile(join(workspaceRoot, CONFIG_PATH), 'utf8');
	} catch (cause) {
		throw new PluginCodegenError('workspace_not_found', `Cannot read ${CONFIG_PATH}`, [], {
			cause,
		});
	}
}

async function readExistingFile(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, 'utf8');
	} catch (cause) {
		if (isMissingFileError(cause)) return undefined;
		throw cause;
	}
}

async function writeFileAtomically(path: string, source: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${process.pid}.tmp`;
	try {
		await writeFile(temporaryPath, source, { encoding: 'utf8', mode: 0o644 });
		await rename(temporaryPath, path);
	} finally {
		await rm(temporaryPath, { force: true });
	}
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
