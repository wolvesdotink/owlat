import { constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, realpath, rename, rm, type FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { PluginCodegenError } from './errors';

interface PathIdentity {
	readonly path: string;
	readonly device: number;
	readonly inode: number;
}

interface GeneratedPathSnapshot {
	readonly realWorkspaceRoot: string;
	readonly parents: readonly PathIdentity[];
}

export async function writeFileAtomically(
	workspaceRoot: string,
	path: string,
	source: string
): Promise<void> {
	const snapshot = await snapshotGeneratedPath(workspaceRoot, path, true);
	const temporaryPath = join(
		snapshot.realWorkspaceRoot,
		`.${basename(path)}.${randomBytes(16).toString('hex')}.tmp`
	);
	let temporaryFile: FileHandle | undefined;
	let temporaryIdentity: PathIdentity | undefined;
	let committedIdentity: PathIdentity | undefined;
	let committedRealPath: string | undefined;
	try {
		await assertParentSnapshot(snapshot, path);
		temporaryFile = await open(
			temporaryPath,
			constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
			0o600
		);
		temporaryIdentity = await identifyOpenFile(temporaryFile, temporaryPath);
		const temporaryRealPath = await realpath(temporaryPath);
		assertPathInside(snapshot.realWorkspaceRoot, temporaryRealPath, path);
		temporaryIdentity = { ...temporaryIdentity, path: temporaryRealPath };
		await assertPathMatchesIdentity(temporaryRealPath, temporaryIdentity, path);
		await assertParentSnapshot(snapshot, path);

		await temporaryFile.writeFile(source, 'utf8');
		await temporaryFile.chmod(0o644);
		await temporaryFile.sync();
		await assertParentSnapshot(snapshot, path);
		await temporaryFile.close();
		temporaryFile = undefined;

		await assertParentSnapshot(snapshot, path);
		await rejectUnsafeTarget(path);
		await rename(temporaryPath, path);
		committedIdentity = temporaryIdentity;
		committedRealPath = await realpath(path);
		assertPathInside(snapshot.realWorkspaceRoot, committedRealPath, path);
		await assertParentSnapshot(snapshot, path);
		await rejectUnsafeTarget(committedRealPath);
	} catch (cause) {
		if (committedRealPath && committedIdentity) {
			await removeExactFile(committedRealPath, committedIdentity);
		}
		if (cause instanceof PluginCodegenError) throw cause;
		throw unsafeGeneratedPath(path, 'changed during the atomic write', cause);
	} finally {
		await temporaryFile?.close();
		if (!committedIdentity && temporaryIdentity) {
			await removeExactFile(temporaryIdentity.path, temporaryIdentity);
		}
	}
}

export async function assertGeneratedPathSafety(
	workspaceRoot: string,
	path: string
): Promise<void> {
	await snapshotGeneratedPath(workspaceRoot, path, false, true);
}

async function snapshotGeneratedPath(
	workspaceRoot: string,
	path: string,
	createParents: boolean,
	allowMissingParents = false
): Promise<GeneratedPathSnapshot> {
	const resolvedRoot = resolve(workspaceRoot);
	const resolvedPath = resolve(path);
	const relativePath = relative(resolvedRoot, resolvedPath);
	if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
		throw unsafeGeneratedPath(path, 'is outside the workspace');
	}

	const rootEntry = await lstat(resolvedRoot);
	if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
		throw unsafeGeneratedPath(path, 'has an unsafe workspace root');
	}
	const realWorkspaceRoot = await realpath(resolvedRoot);
	const parents: PathIdentity[] = [identifyStats(resolvedRoot, rootEntry)];
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
		if (!entry && allowMissingParents) {
			return { realWorkspaceRoot, parents: Object.freeze(parents) };
		}
		if (!entry) throw unsafeGeneratedPath(path, 'has a missing parent directory');
		if (entry.isSymbolicLink() || !entry.isDirectory()) {
			throw unsafeGeneratedPath(path, 'has a symbolic-link or non-directory parent');
		}
		parents.push(identifyStats(current, entry));
	}
	const realParent = await realpath(dirname(resolvedPath));
	assertPathInside(realWorkspaceRoot, realParent, path);
	await rejectUnsafeTarget(resolvedPath);
	return { realWorkspaceRoot, parents: Object.freeze(parents) };
}

async function assertParentSnapshot(snapshot: GeneratedPathSnapshot, path: string): Promise<void> {
	for (const expected of snapshot.parents) {
		const entry = await readPathEntry(expected.path);
		if (
			!entry ||
			entry.isSymbolicLink() ||
			!entry.isDirectory() ||
			entry.dev !== expected.device ||
			entry.ino !== expected.inode
		) {
			throw unsafeGeneratedPath(path, 'has a parent that changed during generation');
		}
	}
	const realParent = await realpath(dirname(resolve(path)));
	assertPathInside(snapshot.realWorkspaceRoot, realParent, path);
}

async function rejectUnsafeTarget(path: string): Promise<void> {
	const entry = await readPathEntry(path);
	if (entry?.isSymbolicLink()) throw unsafeGeneratedPath(path, 'is a symbolic link');
	if (entry && !entry.isFile()) throw unsafeGeneratedPath(path, 'is not a regular file');
}

async function identifyOpenFile(file: FileHandle, path: string): Promise<PathIdentity> {
	return identifyStats(path, await file.stat());
}

function identifyStats(
	path: string,
	stats: { readonly dev: number; readonly ino: number }
): PathIdentity {
	return { path, device: stats.dev, inode: stats.ino };
}

async function assertPathMatchesIdentity(
	path: string,
	expected: PathIdentity,
	generatedPath: string
): Promise<void> {
	const entry = await readPathEntry(path);
	if (
		!entry ||
		!entry.isFile() ||
		entry.isSymbolicLink() ||
		entry.dev !== expected.device ||
		entry.ino !== expected.inode
	) {
		throw unsafeGeneratedPath(generatedPath, 'changed identity during generation');
	}
}

async function removeExactFile(path: string, expected: PathIdentity): Promise<void> {
	try {
		const entry = await lstat(path);
		if (
			entry.isFile() &&
			!entry.isSymbolicLink() &&
			entry.dev === expected.device &&
			entry.ino === expected.inode
		) {
			await rm(path);
		}
	} catch (cause) {
		if (!isFileSystemError(cause, 'ENOENT')) throw cause;
	}
}

function assertPathInside(parent: string, child: string, generatedPath: string): void {
	const path = relative(parent, child);
	if (path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))) return;
	throw unsafeGeneratedPath(generatedPath, 'resolved outside the workspace');
}

async function readPathEntry(path: string) {
	try {
		return await lstat(path);
	} catch (cause) {
		if (isFileSystemError(cause, 'ENOENT')) return undefined;
		throw cause;
	}
}

function unsafeGeneratedPath(path: string, reason: string, cause?: unknown): PluginCodegenError {
	return new PluginCodegenError(
		'generated_path_unsafe',
		`Refusing to write generated plugin composition because ${path} ${reason}`,
		[],
		cause === undefined ? undefined : { cause }
	);
}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
	return error instanceof Error && 'code' in error && error.code === code;
}
