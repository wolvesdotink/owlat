import { join, relative } from 'node:path';
import { assertGeneratedPathSafety, writeFileAtomically } from './atomicWrite';
import { BoundedRepositoryFileError, readBoundedRepositoryUtf8File } from './boundedRepository';
import { MAX_PLUGIN_CONFIG_BYTES, parsePluginsConfig } from './config';
import { PluginCodegenError } from './errors';
import { checkDirectPluginImports } from './packageBoundaries';
import { loadBundledPlugins } from './packageLoader';
import { generatedArtifacts, renderPluginComposition } from './render';

const CONFIG_PATH = 'plugins.config.ts';
const MAX_GENERATED_FILE_BYTES = 4 * 1024 * 1024;

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
	// One table drives the whole output set (see GENERATED_ARTIFACT_PATHS): the
	// writer and the --check staleness gate can never disagree about which files
	// codegen owns.
	const targets = generatedArtifacts(renderPluginComposition(plugins)).map((artifact) => ({
		path: join(workspaceRoot, artifact.outputPath),
		source: artifact.source,
	}));

	if (options.check) {
		const staleFiles: string[] = [];
		for (const target of targets) {
			await assertGeneratedPathSafety(workspaceRoot, target.path);
			if ((await readExistingFile(workspaceRoot, target.path)) !== target.source) {
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

	for (const target of targets) {
		await writeFileAtomically(workspaceRoot, target.path, target.source);
	}
}

async function readConfig(workspaceRoot: string): Promise<string> {
	try {
		return await readBoundedRepositoryUtf8File(
			workspaceRoot,
			join(workspaceRoot, CONFIG_PATH),
			MAX_PLUGIN_CONFIG_BYTES
		);
	} catch (cause) {
		if (!isMissingFileError(cause)) {
			throw new PluginCodegenError(
				'config_invalid',
				`Invalid ${CONFIG_PATH}: must be readable UTF-8 no larger than ${MAX_PLUGIN_CONFIG_BYTES} bytes`,
				[],
				{ cause }
			);
		}
		throw new PluginCodegenError('workspace_not_found', `Cannot read ${CONFIG_PATH}`, [], {
			cause,
		});
	}
}

async function readExistingFile(workspaceRoot: string, path: string): Promise<string | undefined> {
	try {
		return await readBoundedRepositoryUtf8File(workspaceRoot, path, MAX_GENERATED_FILE_BYTES);
	} catch (cause) {
		if (isMissingFileError(cause)) return undefined;
		const relativePath = relative(workspaceRoot, path);
		const limitMessage =
			cause instanceof BoundedRepositoryFileError && cause.reason === 'too_large'
				? `Existing generated file exceeds ${MAX_GENERATED_FILE_BYTES} bytes`
				: 'Existing generated file cannot be read as bounded UTF-8';
		throw new PluginCodegenError('generated_files_stale', limitMessage, [relativePath], {
			cause,
		});
	}
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
	return isFileSystemError(error, 'ENOENT');
}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
	return error instanceof Error && 'code' in error && error.code === code;
}
