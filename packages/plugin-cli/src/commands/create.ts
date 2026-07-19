import { mkdir, readFile, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parsePluginId, PluginIdError } from '@owlat/plugin-kit';
import { parsePackageArgument } from '../config';
import { PluginCliError } from '../errors';
import type { CliIo } from '../io';
import { toPosix } from '../paths';
import { buildScaffold, type ScaffoldFiles } from '../scaffold';

export interface CreateArgs {
	readonly idInput: string;
	readonly name?: string;
	readonly dir?: string;
	readonly dryRun: boolean;
}

/**
 * Scaffold a new plugin package. Purely writes files derived from the id, name,
 * and location — it never installs, imports, or executes anything. The write is
 * idempotent (an identical existing scaffold is a no-op), refuses to clobber a
 * differing file, and rolls back every file and directory it created if any
 * write fails, so a failed run never leaves a half-written package behind.
 */
export async function runCreate(workspaceRoot: string, args: CreateArgs, io: CliIo): Promise<void> {
	const id = parseId(args.idInput);
	const packageName = parsePackageArgument(args.name ?? `@owlat/plugin-${id}`);
	const relativeDir = args.dir ?? join('examples', 'plugins', id);
	const targetDir = resolveTargetDir(workspaceRoot, relativeDir);
	const displayDir = toPosix(relative(workspaceRoot, targetDir));
	const files = buildScaffold(workspaceRoot, targetDir, id, packageName);

	if (args.dryRun) {
		io.log(`Dry run: would scaffold plugin ${id} (${packageName}) in ${displayDir}:`);
		for (const path of sortedPaths(files)) io.log(`  + ${displayDir}/${path}`);
		return;
	}

	const existing = await readExistingFiles(targetDir, files);
	const conflicts = [...files].filter(
		([path, content]) => existing.has(path) && existing.get(path) !== content
	);
	if (conflicts.length > 0) {
		throw new PluginCliError(`Refusing to overwrite existing files in ${displayDir}`, [
			...conflicts.map(([path]) => `${displayDir}/${path} already exists with different content`),
			'Choose a different --dir, remove the conflicting files, or edit them by hand.',
		]);
	}
	if (existing.size === files.size) {
		io.log(`Plugin ${id} is already scaffolded in ${displayDir}; nothing to do.`);
		return;
	}

	await writeScaffold(targetDir, files, existing, displayDir);
	io.log(`Scaffolded plugin ${id} (${packageName}) in ${displayDir}:`);
	for (const path of sortedPaths(files)) io.log(`  + ${displayDir}/${path}`);
	io.log('Declare capabilities and contributions in src/manifest.ts, then run its tests.');
}

function parseId(input: string) {
	try {
		return parsePluginId(input);
	} catch (cause) {
		if (cause instanceof PluginIdError) {
			throw new PluginCliError(
				`"${input}" is not a valid plugin id (expected lowercase kebab-case, at most 64 characters)`,
				[],
				{ cause }
			);
		}
		throw cause;
	}
}

function resolveTargetDir(workspaceRoot: string, relativeDir: string): string {
	const resolved = resolve(workspaceRoot, relativeDir);
	const within = relative(resolve(workspaceRoot), resolved);
	if (within === '' || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) {
		throw new PluginCliError(
			`Refusing to scaffold outside the workspace: ${relativeDir} resolves outside ${workspaceRoot}`
		);
	}
	return resolved;
}

async function readExistingFiles(
	targetDir: string,
	files: ScaffoldFiles
): Promise<Map<string, string>> {
	const existing = new Map<string, string>();
	for (const path of files.keys()) {
		try {
			existing.set(path, await readFile(join(targetDir, ...path.split('/')), 'utf8'));
		} catch (cause) {
			if (isMissingFileError(cause)) continue;
			throw new PluginCliError(`Cannot inspect ${toPosix(join(targetDir, path))}`, [], { cause });
		}
	}
	return existing;
}

async function writeScaffold(
	targetDir: string,
	files: ScaffoldFiles,
	existing: ReadonlyMap<string, string>,
	displayDir: string
): Promise<void> {
	const createdFiles: string[] = [];
	const createdDirs: string[] = [];
	try {
		for (const path of sortedPaths(files)) {
			if (existing.has(path)) continue;
			const absolutePath = join(targetDir, ...path.split('/'));
			await ensureDirectories(dirname(absolutePath), createdDirs);
			await writeFile(absolutePath, files.get(path) ?? '', { encoding: 'utf8', flag: 'wx' });
			createdFiles.push(absolutePath);
		}
	} catch (cause) {
		await rollback(createdFiles, createdDirs);
		throw new PluginCliError(
			`Failed to scaffold ${displayDir}; rolled back the partial scaffold`,
			['No files from this run remain; resolve the error and retry.'],
			{ cause }
		);
	}
}

/**
 * Create every missing directory from `directory` up to the first ancestor that
 * already exists (the workspace root always does), recording each into the
 * caller's `createdDirs` sink the instant `mkdir` succeeds — not only on a clean
 * return. A `mkdir` deeper in the same chain can fail (for example ENOSPC/EDQUOT,
 * or EACCES when a just-created parent is not writable); recording eagerly means
 * an outer directory this call already created is still rolled back rather than
 * orphaned. Containment inside the workspace is guaranteed by `resolveTargetDir`.
 */
async function ensureDirectories(directory: string, createdDirs: string[]): Promise<void> {
	const missing: string[] = [];
	let current = directory;
	while (!(await directoryExists(current))) {
		missing.push(current);
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	for (const dir of missing.reverse()) {
		try {
			await mkdir(dir);
			createdDirs.push(dir);
		} catch (cause) {
			if (!isExistingDirectoryError(cause)) throw cause;
		}
	}
}

async function directoryExists(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch (cause) {
		if (isMissingFileError(cause)) return false;
		throw cause;
	}
}

/**
 * Best-effort removal of everything this run created, innermost first: files
 * before directories, and later-created (deeper) directories before their
 * parents, so each directory is empty by the time it is removed. Directories go
 * through `rmdir` — `rm({ recursive: false })` refuses a directory (EISDIR/EFAULT
 * depending on the runtime), which the swallow below would hide, silently
 * leaving the created tree behind. Any individual removal failure is swallowed so
 * one stubborn entry never masks the original error the caller is about to throw.
 */
async function rollback(
	createdFiles: readonly string[],
	createdDirs: readonly string[]
): Promise<void> {
	for (const file of [...createdFiles].reverse()) {
		await rm(file, { force: true }).catch(() => undefined);
	}
	for (const directory of [...createdDirs].reverse()) {
		await rmdir(directory).catch(() => undefined);
	}
}

function sortedPaths(files: ScaffoldFiles): readonly string[] {
	return [...files.keys()].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function isMissingFileError(error: unknown): boolean {
	return isFileSystemError(error, 'ENOENT');
}

function isExistingDirectoryError(error: unknown): boolean {
	return isFileSystemError(error, 'EEXIST');
}

function isFileSystemError(error: unknown, code: string): boolean {
	return error instanceof Error && 'code' in error && error.code === code;
}
