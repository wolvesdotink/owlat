import { spawn } from 'node:child_process';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { PluginCodegenError } from './errors';

const ATOMIC_COMMIT_HELPER = fileURLToPath(new URL('./atomicCommit.mjs', import.meta.url));

interface PathIdentity {
	readonly path: string;
	readonly device: number;
	readonly inode: number;
}

interface GeneratedPathSnapshot {
	readonly realWorkspaceRoot: string;
	readonly parents: readonly PathIdentity[];
}

interface AtomicWriteHooks {
	/** Test-only synchronization at the stable-directory worker's commit boundary. */
	readonly beforeCommit?: () => void | Promise<void>;
}

export async function writeFileAtomically(
	workspaceRoot: string,
	path: string,
	source: string,
	hooks: AtomicWriteHooks = {}
): Promise<void> {
	const snapshot = await snapshotGeneratedPath(workspaceRoot, path, true);
	const targetParent = snapshot.parents.at(-1);
	if (!targetParent) throw unsafeGeneratedPath(path, 'has no stable generated parent');
	try {
		await assertParentSnapshot(snapshot, path);
		await commitFromStableParent(targetParent, basename(path), source, hooks);
		await assertParentSnapshot(snapshot, path);
	} catch (cause) {
		if (cause instanceof PluginCodegenError) throw cause;
		throw unsafeGeneratedPath(path, 'changed during the atomic write', cause);
	}
}

async function commitFromStableParent(
	parent: PathIdentity,
	targetName: string,
	source: string,
	hooks: AtomicWriteHooks
): Promise<void> {
	const child = spawn(
		process.execPath,
		[ATOMIC_COMMIT_HELPER, String(parent.device), String(parent.inode), targetName],
		{ cwd: parent.path, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] }
	);
	if (!child.stdin || !child.stdout || !child.stderr) {
		child.kill();
		throw new Error('Cannot open atomic commit worker streams');
	}
	const control = child.stdio[3];
	if (!control || !('write' in control)) {
		child.kill();
		throw new Error('Cannot open atomic commit worker control stream');
	}

	let stdout = '';
	let stderr = '';
	let ready = false;
	let resolveReady: (() => void) | undefined;
	const readySignal = new Promise<void>((resolve) => {
		resolveReady = resolve;
	});
	child.stdout.on('data', (chunk: Buffer) => {
		stdout = appendBoundedOutput(stdout, chunk);
		if (!ready && stdout.includes('READY\n')) {
			ready = true;
			resolveReady?.();
		}
	});
	child.stderr.on('data', (chunk: Buffer) => {
		stderr = appendBoundedOutput(stderr, chunk);
	});
	child.stdin.on('error', () => undefined);

	const exit = new Promise<{
		readonly code: number | null;
		readonly signal: NodeJS.Signals | null;
	}>((resolveExit, rejectExit) => {
		child.once('error', rejectExit);
		child.once('close', (code, signal) => resolveExit({ code, signal }));
	});
	child.stdin.end(source, 'utf8');
	await Promise.race([
		readySignal,
		exit.then(({ code, signal }) => {
			throw new Error(
				`Atomic commit worker exited before commit (${code ?? signal ?? 'unknown'}): ${stderr}`
			);
		}),
	]);

	try {
		await hooks.beforeCommit?.();
		(control as Writable).end('COMMIT\n');
	} catch (cause) {
		(control as Writable).end();
		await exit.catch(() => undefined);
		throw cause;
	}
	const result = await exit;
	if (result.code !== 0 || !stdout.includes('DONE\n')) {
		throw new Error(
			`Atomic commit worker failed (${result.code ?? result.signal ?? 'unknown'}): ${stderr}`
		);
	}
}

function appendBoundedOutput(output: string, chunk: Buffer): string {
	return `${output}${chunk.toString('utf8')}`.slice(-4096);
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

function identifyStats(
	path: string,
	stats: { readonly dev: number; readonly ino: number }
): PathIdentity {
	return { path, device: stats.dev, inode: stats.ino };
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
