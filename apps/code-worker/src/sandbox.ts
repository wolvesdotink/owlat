import { execFileSync, spawn, type ExecFileSyncOptions } from 'node:child_process';
import { statSync } from 'node:fs';
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
 * Kill an entire process group given the group leader's pid.
 *
 * The untrusted children (the coding agent, `npx vitest`) are spawned
 * `detached`, so each becomes the leader of its OWN process group. Signalling
 * the NEGATIVE pid reaps the whole group — the direct child *and* every
 * grandchild it spawned (vitest's worker pool, detached helpers) — instead of
 * leaving orphaned workers running after a timeout. The `kill` param is
 * injectable so the group-targeting can be unit-tested without real processes.
 */
export function killProcessGroup(
	pid: number | undefined,
	kill: (targetPid: number, signal: NodeJS.Signals) => void = process.kill
): void {
	if (!pid || pid <= 0) return;
	try {
		kill(-pid, 'SIGKILL');
	} catch {
		// The group already exited between the timeout firing and this signal.
	}
}

export interface DetachedRunResult {
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

/**
 * Run an UNTRUSTED subprocess in its own process group and, on timeout, kill the
 * WHOLE group.
 *
 * `execFileSync`'s built-in `timeout` only signals the direct child, so a
 * timed-out `vitest` run would leave its detached worker pool alive — still
 * burning CPU/memory against the container's resource limits. Spawning
 * `detached` (a new process group) and killing the negative pid guarantees the
 * entire process tree is reaped when the deadline is hit. `shell: false` is
 * kept (spawn with an argv array), preserving the shell-injection isolation the
 * argv builders rely on.
 */
function runDetached(
	command: string,
	args: string[],
	opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; uid?: number; gid?: number },
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

		child.stdout?.on('data', (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr?.on('data', (chunk: Buffer) => {
			stderr += chunk.toString();
		});

		const timer = setTimeout(() => {
			timedOut = true;
			killProcessGroup(child.pid);
		}, opts.timeoutMs);

		child.once('error', (err) => {
			clearTimeout(timer);
			reject(err);
		});
		child.once('close', (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr, timedOut });
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
	opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
	spawnFn: typeof spawn = spawn
): Promise<DetachedRunResult> {
	return runDetached(command, args, { ...opts, uid: SANDBOX_UID, gid: SANDBOX_GID }, spawnFn);
}

/**
 * Run a TRUSTED git command as the orchestrator (ROOT — no uid/gid drop).
 *
 * These are the only commands that carry the GITHUB_TOKEN (out-of-band via
 * `-c http.extraheader`), so they MUST run as root and MUST NOT be dropped to
 * the sandbox uid: the token would otherwise land in a sandbox-readable
 * /proc/<pid>/cmdline. Root git reads the (world-readable) sandbox-owned working
 * tree and writes only the root-owned .git, so no DAC_OVERRIDE cap is needed.
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
 * Hand the working tree to the sandbox uid so the untrusted agent can WRITE it,
 * while re-asserting root ownership of `.git` so trusted root git keeps working
 * with no dubious-ownership / EACCES and the token-bearing .git stays unreadable
 * by the sandbox. Runs as root BEFORE the agent; needs only CAP_CHOWN.
 */
export function handOffWorkspaceToSandbox(workDir: string): void {
	execFileSync('chown', ['-R', `${SANDBOX_UID}:${SANDBOX_GID}`, workDir], { stdio: 'inherit' });
	execFileSync('chown', ['-R', '0:0', path.join(workDir, '.git')], { stdio: 'inherit' });
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
