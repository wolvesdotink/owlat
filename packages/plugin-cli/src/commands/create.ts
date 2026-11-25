import { mkdir, readFile, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parsePluginId, PluginIdError } from '@owlat/plugin-kit';
import { parsePackageArgument } from '../config';
import { PluginCliError } from '../errors';
import type { CliIo } from '../io';
import { compareStrings, toPosix } from '../paths';
import {
	buildScaffold,
	DEFAULT_SCAFFOLD_TEMPLATE,
	parseScaffoldTemplate,
	SCAFFOLD_TEMPLATE_DEFINITIONS,
	type ScaffoldFiles,
	type StandaloneVersions,
} from '../scaffold';

export interface CreateArgs {
	readonly idInput: string;
	readonly name?: string;
	readonly dir?: string;
	/** `--template`; absent means the minimal skeleton. */
	readonly template?: string;
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
	// Parsed BEFORE the target directory is touched, so an unknown template name
	// fails with the accepted set rather than after a directory has been created.
	const template =
		args.template === undefined ? DEFAULT_SCAFFOLD_TEMPLATE : parseScaffoldTemplate(args.template);
	const relativeDir = args.dir ?? join('examples', 'plugins', id);
	const { targetDir, insideWorkspace } = resolveTargetDir(workspaceRoot, relativeDir);
	// A package outside the checkout is named by its absolute path: relative to
	// the checkout it would read as a chain of `../`.
	const displayDir = toPosix(insideWorkspace ? relative(workspaceRoot, targetDir) : targetDir);
	const standalone = insideWorkspace ? undefined : await readStandaloneVersions(workspaceRoot);
	const files = buildScaffold(workspaceRoot, targetDir, id, packageName, template, standalone);

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
	// LOOKED UP, NOT COMPARED: the hint is one field of the template's own record,
	// beside the file set and the export map it belongs with, so a new template
	// cannot ship printing another template's next step.
	io.log(SCAFFOLD_TEMPLATE_DEFINITIONS[template].completionHint);
	if (standalone !== undefined) {
		io.log(
			`${displayDir} is outside this checkout, so it installs @owlat/plugin-kit ${standalone.pluginKit} from npm: run \`bun install\` in it first.`
		);
	}
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

/**
 * Where the package goes, and whether that is inside this checkout. Inside, it
 * is a workspace member; outside, it gets the standalone layout. The checkout
 * root itself and any directory that contains it are refused: a scaffold there
 * would write its `package.json` over or around the workspace's own.
 */
function resolveTargetDir(
	workspaceRoot: string,
	relativeDir: string
): { readonly targetDir: string; readonly insideWorkspace: boolean } {
	const root = resolve(workspaceRoot);
	const targetDir = resolve(root, relativeDir);
	const within = relative(root, targetDir);
	const rootFromTarget = relative(targetDir, root);
	const containsRoot = !escapes(rootFromTarget);
	if (containsRoot) {
		throw new PluginCliError(
			`Refusing to scaffold into ${relativeDir}: it is the checkout root or contains it`
		);
	}
	return { targetDir, insideWorkspace: !escapes(within) };
}

/** Whether a `relative()` result leaves the directory it was measured from. */
function escapes(path: string): boolean {
	return path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path);
}

/**
 * The ranges a standalone package names: this checkout's kit version, and the
 * workspace catalog's versions of the tools its scripts run, so a standalone
 * plugin builds with the toolchain the checkout tests the kit with.
 */
async function readStandaloneVersions(workspaceRoot: string): Promise<StandaloneVersions> {
	const rootManifest = await readJsonObject(join(workspaceRoot, 'package.json'));
	const kitManifest = await readJsonObject(
		join(workspaceRoot, 'packages', 'plugin-kit', 'package.json')
	);
	const workspaces = rootManifest['workspaces'];
	const catalog =
		isRecord(workspaces) && isRecord(workspaces['catalog']) ? workspaces['catalog'] : {};
	const devDependencies = isRecord(rootManifest['devDependencies'])
		? rootManifest['devDependencies']
		: {};
	const pick = (source: Record<string, unknown>, name: string, where: string): string => {
		const value = source[name];
		if (typeof value === 'string' && value.length > 0) return value;
		throw new PluginCliError(`Cannot scaffold a standalone plugin: ${where} names no ${name}`);
	};
	const kitVersion = pick(kitManifest, 'version', 'packages/plugin-kit/package.json');
	return {
		pluginKit: `^${kitVersion}`,
		typesNode: pick(catalog, '@types/node', 'the workspace catalog'),
		typescript: pick(catalog, 'typescript', 'the workspace catalog'),
		vitest: pick(catalog, 'vitest', 'the workspace catalog'),
		oxlint: pick(devDependencies, 'oxlint', "the root package.json's devDependencies"),
	};
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(path, 'utf8'));
	} catch (cause) {
		throw new PluginCliError(`Cannot read ${toPosix(path)}`, [], { cause });
	}
	if (!isRecord(parsed)) throw new PluginCliError(`${toPosix(path)} is not a JSON object`);
	return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
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
 * already exists (the filesystem root always does), recording each into the
 * caller's `createdDirs` sink the instant `mkdir` succeeds — not only on a clean
 * return. A `mkdir` deeper in the same chain can fail (for example ENOSPC/EDQUOT,
 * or EACCES when a just-created parent is not writable); recording eagerly means
 * an outer directory this call already created is still rolled back rather than
 * orphaned.
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
	return [...files.keys()].sort(compareStrings);
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
