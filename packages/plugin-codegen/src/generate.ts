import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
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
			await assertGeneratedPathSafety(workspaceRoot, target.path, false);
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

	for (const target of targets) {
		await writeFileAtomically(workspaceRoot, target.path, target.source);
	}
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

async function writeFileAtomically(
	workspaceRoot: string,
	path: string,
	source: string
): Promise<void> {
	await assertGeneratedPathSafety(workspaceRoot, path, true);
	const temporaryPath = join(
		dirname(path),
		`.${basename(path)}.${randomBytes(16).toString('hex')}.tmp`
	);
	let temporaryFile;
	try {
		temporaryFile = await open(
			temporaryPath,
			constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
			0o600
		);
		await temporaryFile.writeFile(source, 'utf8');
		await temporaryFile.chmod(0o644);
		await temporaryFile.sync();
		await temporaryFile.close();
		temporaryFile = undefined;
		await rejectSymbolicLink(path);
		await rename(temporaryPath, path);
	} finally {
		await temporaryFile?.close();
		await rm(temporaryPath, { force: true });
	}
}

async function assertGeneratedPathSafety(
	workspaceRoot: string,
	path: string,
	createParents: boolean
): Promise<void> {
	const resolvedRoot = resolve(workspaceRoot);
	const resolvedPath = resolve(path);
	const relativePath = relative(resolvedRoot, resolvedPath);
	if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
		throw unsafeGeneratedPath(path, 'is outside the workspace');
	}

	let current = resolvedRoot;
	const parentParts = relative(resolvedRoot, dirname(resolvedPath)).split(sep).filter(Boolean);
	for (const part of parentParts) {
		current = join(current, part);
		let entry = await readPathEntry(current);
		if (!entry && createParents) {
			try {
				await mkdir(current, { mode: 0o755 });
			} catch (cause) {
				if (!isFileSystemError(cause, 'EEXIST')) throw cause;
			}
			entry = await readPathEntry(current);
		}
		if (!entry) return;
		if (entry.isSymbolicLink() || !entry.isDirectory()) {
			throw unsafeGeneratedPath(path, 'has a symbolic-link or non-directory parent');
		}
	}
	await rejectSymbolicLink(resolvedPath);
}

async function rejectSymbolicLink(path: string): Promise<void> {
	const entry = await readPathEntry(path);
	if (entry?.isSymbolicLink()) {
		throw unsafeGeneratedPath(path, 'is a symbolic link');
	}
	if (entry && !entry.isFile()) {
		throw unsafeGeneratedPath(path, 'is not a regular file');
	}
}

async function readPathEntry(path: string) {
	try {
		return await lstat(path);
	} catch (cause) {
		if (isFileSystemError(cause, 'ENOENT')) return undefined;
		throw cause;
	}
}

function unsafeGeneratedPath(path: string, reason: string): PluginCodegenError {
	return new PluginCodegenError(
		'generated_path_unsafe',
		`Refusing to write generated plugin composition because ${path} ${reason}`
	);
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
	return isFileSystemError(error, 'ENOENT');
}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
	return error instanceof Error && 'code' in error && error.code === code;
}
