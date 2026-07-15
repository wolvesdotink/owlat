import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { PluginCodegenError } from './errors';

const MAX_GIT_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_REPOSITORY_FILES = 20_000;
const MAX_FALLBACK_DIRECTORIES = 4_096;
const MAX_FALLBACK_DEPTH = 32;
const SKIPPED_FALLBACK_DIRECTORIES = new Set([
	'.nuxt',
	'.output',
	'.turbo',
	'coverage',
	'dist',
	'node_modules',
	'target',
]);

/** Build one deterministic, bounded inventory for every repository security scan. */
export async function listRepositoryFiles(workspaceRoot: string): Promise<readonly string[]> {
	const gitMetadata = await readPathEntry(join(workspaceRoot, '.git'));
	const paths = gitMetadata
		? listTrackedRepositoryFiles(workspaceRoot)
		: await listRepositoryFilesWithoutGit(workspaceRoot);
	if (paths.length > MAX_REPOSITORY_FILES) {
		throw new PluginCodegenError(
			'repository_inventory_invalid',
			`Repository scan exceeds the ${MAX_REPOSITORY_FILES}-file safety limit`
		);
	}
	return Object.freeze(paths.sort());
}

/** Read one regular, contained UTF-8 file without allowing growth past the byte bound. */
export async function readBoundedRepositoryUtf8File(
	workspaceRoot: string,
	path: string,
	maxBytes: number
): Promise<string> {
	const resolvedRoot = resolve(workspaceRoot);
	const resolvedPath = resolve(path);
	assertPathInside(resolvedRoot, resolvedPath);
	const realRoot = await realpath(resolvedRoot);
	const file = await open(resolvedPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const opened = await file.stat();
		if (!opened.isFile()) throw new Error('Path is not a regular file');
		if (opened.size > maxBytes) throw new Error(`File exceeds ${maxBytes} bytes`);

		const current = await lstat(resolvedPath);
		if (
			current.isSymbolicLink() ||
			!current.isFile() ||
			current.dev !== opened.dev ||
			current.ino !== opened.ino
		) {
			throw new Error('File changed identity while it was opened');
		}
		assertPathInside(realRoot, await realpath(resolvedPath));

		const buffer = Buffer.allocUnsafe(maxBytes + 1);
		let offset = 0;
		for (;;) {
			const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
			if (bytesRead === 0) break;
			offset += bytesRead;
			if (offset > maxBytes) throw new Error(`File exceeds ${maxBytes} bytes`);
		}
		return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset));
	} finally {
		await file.close();
	}
}

function listTrackedRepositoryFiles(workspaceRoot: string): string[] {
	let output: string;
	try {
		output = execFileSync(
			'git',
			[
				'-C',
				workspaceRoot,
				'ls-files',
				'-z',
				'--',
				'package.json',
				'tsconfig*.json',
				'*.config.cjs',
				'*.config.cts',
				'*.config.js',
				'*.config.mjs',
				'*.config.mts',
				'*.config.ts',
				'apps',
				'packages',
			],
			{
				encoding: 'utf8',
				maxBuffer: MAX_GIT_OUTPUT_BYTES,
				stdio: ['ignore', 'pipe', 'ignore'],
			}
		);
	} catch (cause) {
		throw new PluginCodegenError(
			'repository_inventory_invalid',
			'Cannot build the bounded tracked repository file inventory',
			[],
			{ cause }
		);
	}

	return output
		.split('\0')
		.filter(Boolean)
		.map((path) => resolveTrackedPath(workspaceRoot, path));
}

async function listRepositoryFilesWithoutGit(workspaceRoot: string): Promise<string[]> {
	const files: string[] = [];
	let directories = 0;
	const addFile = (path: string): void => {
		files.push(path);
		if (files.length > MAX_REPOSITORY_FILES) {
			throw new PluginCodegenError(
				'repository_inventory_invalid',
				`Repository scan exceeds the ${MAX_REPOSITORY_FILES}-file safety limit`
			);
		}
	};
	const visit = async (directory: string, depth: number): Promise<void> => {
		directories += 1;
		if (directories > MAX_FALLBACK_DIRECTORIES || depth > MAX_FALLBACK_DEPTH) {
			throw new PluginCodegenError(
				'repository_inventory_invalid',
				'Repository fallback scan exceeds its directory or depth safety limit'
			);
		}
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				if (!SKIPPED_FALLBACK_DIRECTORIES.has(entry.name)) await visit(path, depth + 1);
			} else {
				addFile(path);
			}
		}
	};

	for (const entry of await readdir(workspaceRoot, { withFileTypes: true })) {
		if (!entry.isDirectory()) addFile(join(workspaceRoot, entry.name));
	}
	for (const group of ['apps', 'packages']) {
		const path = join(workspaceRoot, group);
		try {
			await visit(path, 0);
		} catch (cause) {
			if (!isFileSystemError(cause, 'ENOENT')) throw cause;
		}
	}
	return files;
}

function resolveTrackedPath(workspaceRoot: string, trackedPath: string): string {
	if (
		trackedPath.length === 0 ||
		isAbsolute(trackedPath) ||
		trackedPath.split('/').some((part) => part === '..')
	) {
		throw new PluginCodegenError(
			'repository_inventory_invalid',
			'Git returned an unsafe tracked repository path'
		);
	}
	const path = resolve(workspaceRoot, ...trackedPath.split('/'));
	assertPathInside(resolve(workspaceRoot), path);
	return path;
}

function assertPathInside(parent: string, child: string): void {
	const path = relative(parent, child);
	if (path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))) return;
	throw new Error(`Path ${child} is outside ${parent}`);
}

async function readPathEntry(path: string) {
	try {
		return await lstat(path);
	} catch (cause) {
		if (isFileSystemError(cause, 'ENOENT')) return undefined;
		throw cause;
	}
}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
	return error instanceof Error && 'code' in error && error.code === code;
}
