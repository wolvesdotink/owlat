import { execFileSync, spawn, type ExecFileSyncOptions } from 'node:child_process';
import { chmodSync, chownSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Sandbox-execution seam for the code-worker.
 *
 * The orchestrator (poll loop + taskRunner) holds CONVEX_ADMIN_KEY /
 * GITHUB_TOKEN / LLM_API_KEY in its process env and runs as CONFINED root. The
 * UNTRUSTED children it spawns (the coding agent + `npx vitest`) must sit behind
 * a hard cross-uid kernel boundary so they cannot read /proc/<orchestrator>/
 * environ or ptrace the orchestrator to recover those secrets. This module is
 * the single place that draws that boundary: `runUntrusted` always drops to the
 * unprivileged sandbox uid/gid, while `runGit` (which carries the token
 * out-of-band) deliberately stays root. Both seams take an injectable
 * spawn/exec fn so the trusted/untrusted split is unit-testable.
 */

/**
 * Unprivileged uid/gid the UNTRUSTED children (the coding agent + `npx vitest`)
 * are dropped to. This MUST match the `sandbox` account baked into the
 * Dockerfile (uid=10001 gid=10001). The orchestrator itself runs as CONFINED
 * root purely so it can setuid to these ids; the secrets it holds (admin key,
 * GITHUB_TOKEN, LLM key) then sit behind a cross-uid kernel boundary the
 * children cannot cross via /proc/<pid>/environ or ptrace. Overridable only for
 * tests / non-default images.
 */
export const SANDBOX_UID = Number(process.env['CODE_SANDBOX_UID'] ?? 10001);
export const SANDBOX_GID = Number(process.env['CODE_SANDBOX_GID'] ?? 10001);

/**
 * Reap every process using the dedicated sandbox uid, including setsid children.
 * The worker runs one job at a time in its own PID namespace. A helper drops to
 * that uid before signalling: confined root has no CAP_KILL and cannot signal
 * its cross-uid children. Linux kill(-1) excludes the caller and PID 1, and the
 * helper has no capability to signal other uids. No credentials reach it.
 *
 * A failed cleanup is fatal: continuing would let an old task overlap trusted
 * Git operations or a new job. Exiting PID 1 tears down the container's tasks.
 */
export function reapSandboxProcesses(
	spawnFn: typeof spawn = spawn,
	fatal: (code: number) => never = process.exit
): Promise<void> {
	return new Promise((resolve, reject) => {
		if (
			!Number.isInteger(SANDBOX_UID) ||
			SANDBOX_UID <= 0 ||
			!Number.isInteger(SANDBOX_GID) ||
			SANDBOX_GID <= 0
		) {
			throw new Error('Sandbox uid and gid must be positive integers');
		}
		let settled = false;
		const fail = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			console.error('Sandbox process cleanup failed; stopping the worker');
			try {
				fatal(1);
			} catch (error) {
				reject(error);
			}
		};
		// Stay asynchronous: hostile same-uid code can stop the helper. Root
		// cannot signal it without CAP_KILL, so the parent deadline must still run.
		const timer = setTimeout(fail, 5_000);
		try {
			const helper = spawnFn(
				process.execPath,
				[
					'-e',
					"try { process.kill(-1, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }",
				],
				{
					uid: SANDBOX_UID,
					gid: SANDBOX_GID,
					env: {},
					cwd: '/',
					stdio: 'ignore',
				}
			);
			helper.once('error', fail);
			helper.once('exit', (code) => {
				if (settled) return;
				if (code !== 0) return fail();
				settled = true;
				clearTimeout(timer);
				resolve();
			});
		} catch {
			fail();
		}
	});
}

export interface DetachedRunResult {
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	/** True when an external cancellation (AbortSignal) reaped the sandbox processes. */
	killed: boolean;
}

/** Options shared by every sandboxed run. */
export interface SandboxRunOptions {
	cwd: string;
	env: NodeJS.ProcessEnv;
	timeoutMs: number;
	/**
	 * Cooperative cancellation. When it aborts, all sandbox processes are reaped, including
	 * detached grandchildren, before the next task can start.
	 */
	signal?: AbortSignal;
	/** Injectable cleanup for tests; production reaps the dedicated sandbox uid. */
	reap?: () => void | Promise<void>;
}

/** Run untrusted code and reap sandbox processes before reporting its result. */
function runDetached(
	command: string,
	args: string[],
	opts: SandboxRunOptions & { uid?: number; gid?: number },
	spawnFn: typeof spawn = spawn
): Promise<DetachedRunResult> {
	return new Promise((resolve, reject) => {
		const child = spawnFn(command, args, {
			cwd: opts.cwd,
			env: opts.env,
			detached: true,
			stdio: ['ignore', 'pipe', 'pipe'],
			// When uid/gid are set (the UNTRUSTED runs) the child is dropped to the
			// unprivileged sandbox account before exec, so it runs behind a cross-uid
			// boundary from the secret-holding root orchestrator. Omitted for trusted
			// git ops, which stay root. Requires CAP_SETUID/CAP_SETGID (see compose).
			...(opts.uid !== undefined ? { uid: opts.uid } : {}),
			...(opts.gid !== undefined ? { gid: opts.gid } : {}),
		});

		let stdout = '';
		let stderr = '';
		let timedOut = false;
		let killed = false;
		let reaping: Promise<void> | undefined;
		const reap = () =>
			(reaping ??= Promise.resolve().then(() => (opts.reap ?? reapSandboxProcesses)()));

		child.stdout?.on('data', (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr?.on('data', (chunk: Buffer) => {
			stderr += chunk.toString();
		});

		const timer = setTimeout(() => {
			timedOut = true;
			void reap().catch(reject);
		}, opts.timeoutMs);

		// Operator cancellation reaps the dedicated uid, including detached children.
		const onAbort = () => {
			killed = true;
			void reap().catch(reject);
		};
		if (opts.signal) {
			if (opts.signal.aborted) onAbort();
			else opts.signal.addEventListener('abort', onAbort, { once: true });
		}
		const cleanup = () => {
			clearTimeout(timer);
			opts.signal?.removeEventListener('abort', onAbort);
		};

		// Exit precedes close: descendants can keep stdout open after their parent
		// exits. Reap them here so close is guaranteed to follow. Also clean up
		// successful jobs, which may have left detached background processes.
		child.once('exit', () => {
			cleanup();
			void reap().catch(reject);
		});
		child.once('error', (err) => {
			cleanup();
			void reap().then(() => reject(err), reject);
		});
		child.once('close', (code) => {
			cleanup();
			void reap().then(() => resolve({ code, stdout, stderr, timedOut, killed }), reject);
		});
	});
}

/**
 * Run an UNTRUSTED child (the coding agent or `npx vitest`) dropped to the
 * unprivileged sandbox uid/gid.
 *
 * This is the single seam through which every attacker-influenced process is
 * launched: it ALWAYS pins uid=SANDBOX_UID / gid=SANDBOX_GID, so the child runs
 * behind a cross-uid kernel boundary from the root orchestrator and cannot read
 * its /proc/<pid>/environ or ptrace it to recover the admin key / GITHUB_TOKEN.
 * Trusted git ops deliberately do NOT go through here — they run via `runGit`,
 * which stays root (no uid/gid drop). `spawnFn` is injectable so
 * the uid/gid wiring can be unit-tested without spawning real processes.
 */
export function runUntrusted(
	command: string,
	args: string[],
	opts: SandboxRunOptions,
	spawnFn: typeof spawn = spawn
): Promise<DetachedRunResult> {
	if (
		!Number.isInteger(SANDBOX_UID) ||
		SANDBOX_UID <= 0 ||
		!Number.isInteger(SANDBOX_GID) ||
		SANDBOX_GID <= 0
	) {
		throw new Error('Sandbox uid and gid must be positive integers');
	}
	return runDetached(command, args, { ...opts, uid: SANDBOX_UID, gid: SANDBOX_GID }, spawnFn);
}

/**
 * Run a TRUSTED git command as the orchestrator (ROOT — no uid/gid drop).
 *
 * These are the only commands that carry the GITHUB_TOKEN (out-of-band via
 * Git config environment variables), so they stay root: the token would otherwise
 * land in a sandbox-readable /proc/<pid>/environ. Command lines never carry
 * authentication headers. Root Git writes only the root-owned .git directory.
 * `execFn` is injectable so the trusted/untrusted split can be unit-tested.
 */
export function runGit(
	args: string[],
	opts: ExecFileSyncOptions = {},
	execFn: (cmd: string, args: string[], opts: ExecFileSyncOptions) => string | Buffer = execFileSync
): string | Buffer {
	return execFn('git', args, opts);
}

/**
 * Hand working files to the sandbox, preserving a root-owned repository boundary.
 * The root directory is group-writable with the sticky bit: the sandbox can
 * create/edit its files but cannot rename or replace root-owned `.git`, even
 * though it can write the parent directory. Otherwise replacing `.git` could
 * plant hooks/configuration for subsequent privileged Git commands.
 */
export function handOffWorkspaceToSandbox(workDir: string): void {
	execFileSync('chown', ['-R', `${SANDBOX_UID}:${SANDBOX_GID}`, workDir], { stdio: 'inherit' });
	execFileSync('chown', ['-R', '0:0', path.join(workDir, '.git')], { stdio: 'inherit' });
	chownSync(workDir, 0, SANDBOX_GID);
	chmodSync(workDir, 0o1770);
}

/**
 * Hand a plugin-job scratch directory to the sandbox uid so the untrusted job
 * (which runs as uid 10001) can write to it, while the directory itself stays
 * under the orchestrator's `/workspace`. Unlike `handOffWorkspaceToSandbox` this
 * has no `.git` to keep root-owned — a plugin job carries no repository and no
 * out-of-band token. Runs as root BEFORE the job; needs only CAP_CHOWN.
 */
export function chownDirToSandbox(dir: string): void {
	execFileSync('chown', ['-R', `${SANDBOX_UID}:${SANDBOX_GID}`, dir], { stdio: 'inherit' });
}

/**
 * True if `<workDir>/.git` exists and is owned by root (uid 0).
 *
 * A reused workDir whose .git is NOT root-owned means a previous sandbox run
 * chowned it (or the tree is otherwise untrusted): trusted root git would then
 * hit a dubious-ownership refusal, and worse, a sandbox-owned .git could hide a
 * hostile hook. Such a dir must be discarded and re-cloned fresh, not pulled.
 */
export function isGitDirRootOwned(workDir: string): boolean {
	try {
		return statSync(path.join(workDir, '.git')).uid === 0;
	} catch {
		return false;
	}
}
