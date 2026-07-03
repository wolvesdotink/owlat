import { execFileSync, spawn, type ExecFileSyncOptions } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { getConvexClient, fn, type CodeWorkTask } from './convexClient.js';
import { createPullRequest } from './github.js';

const WORKSPACE_ROOT = process.env['WORKSPACE_ROOT'] ?? '/workspace';
const GIT_REPO_URL = process.env['GIT_REPO_URL'] ?? '';
// Tokenless clone URL + out-of-band auth args. The credential in GIT_REPO_URL is
// NEVER written into the workspace .git/config (see parseRepoUrl).
const { cleanUrl: GIT_CLEAN_URL, authArgs: GIT_AUTH_ARGS } = parseRepoUrl(GIT_REPO_URL);
const GIT_BASE_BRANCH = process.env['GIT_BASE_BRANCH'] ?? 'main';
const GITHUB_OWNER = process.env['GITHUB_OWNER'] ?? '';
const GITHUB_REPO = process.env['GITHUB_REPO'] ?? '';

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

function log(msg: string) {
	console.info(`[code-worker] ${new Date().toISOString()} ${msg}`);
}

/**
 * Pure argv-array builders for every external command this worker runs.
 *
 * SECURITY: task descriptions originate from UNTRUSTED inbound email
 * (`internal.codeWorkTasks.createFromInbound`). These builders return discrete
 * argument vectors that are always executed with `shell: false` (no
 * `/bin/sh -c`), so attacker-controlled text such as `$(id)`, backticks, or
 * `"; rm -rf / #` is passed as a single literal argv element and is never
 * interpreted by a shell. They are exported so the invariant can be unit-tested.
 */
/**
 * Split a clone URL that embeds credentials (e.g.
 * `https://x-access-token:ghp_xxx@github.com/o/r.git`) into a tokenless URL plus
 * the git `-c http.extraheader=...` argv that carries the credential out-of-band.
 *
 * SECURITY: the credential must never be persisted into `<workDir>/.git/config`,
 * because the untrusted OpenCode agent (and `npx vitest`) run with that workspace
 * as cwd/HOME and could read it straight off disk — defeating the env-stripping
 * isolation in buildAgentEnv. Cloning the tokenless URL keeps `.git/config`
 * secret-free; the per-invocation `http.extraheader` authenticates clone/pull/push
 * without writing the token anywhere, and those commands only ever run while NO
 * untrusted child is executing (clone/pull before the agent, push after tests).
 */
export function parseRepoUrl(repoUrl: string): { cleanUrl: string; authArgs: string[] } {
	try {
		const u = new URL(repoUrl);
		if (u.username || u.password) {
			const userinfo = `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`;
			const basic = Buffer.from(userinfo).toString('base64');
			u.username = '';
			u.password = '';
			return {
				cleanUrl: u.toString(),
				authArgs: ['-c', `http.extraheader=Authorization: Basic ${basic}`],
			};
		}
	} catch {
		// Not a parseable URL (e.g. an scp-style git@host:path) — pass through.
	}
	return { cleanUrl: repoUrl, authArgs: [] };
}

export function buildCloneArgs(
	repoUrl: string,
	baseBranch: string,
	workDir: string,
	authArgs: string[] = []
): string[] {
	return [...authArgs, 'clone', '--depth', '1', '--branch', baseBranch, repoUrl, workDir];
}

export function buildPullArgs(
	workDir: string,
	baseBranch: string,
	authArgs: string[] = []
): string[] {
	return [...authArgs, '-C', workDir, 'pull', 'origin', baseBranch];
}

/** Force `origin` to a (tokenless) URL — scrubs any credential a prior run may
 * have persisted into a reused workspace's .git/config. */
export function buildSetOriginUrlArgs(workDir: string, url: string): string[] {
	return ['-C', workDir, 'remote', 'set-url', 'origin', url];
}

export function buildCheckoutArgs(workDir: string, branchName: string): string[] {
	return ['-C', workDir, 'checkout', '-b', branchName];
}

export function buildDiffStatArgs(workDir: string): string[] {
	return ['-C', workDir, 'diff', '--stat'];
}

export function buildAddArgs(workDir: string): string[] {
	return ['-C', workDir, 'add', '-A'];
}

export function buildCommitArgs(workDir: string, message: string): string[] {
	return ['-C', workDir, 'commit', '-m', message];
}

export function buildPushArgs(
	workDir: string,
	branchName: string,
	authArgs: string[] = []
): string[] {
	return [...authArgs, '-C', workDir, 'push', 'origin', branchName];
}

/**
 * Branch name derived solely from the (trusted, Convex-generated) task id, so it
 * cannot contain attacker-controlled metacharacters even before argv isolation.
 */
export function buildBranchName(taskId: string): string {
	return `code-worker/${taskId}`;
}

/**
 * Build the OpenCode argv. The untrusted description is a single `--message`
 * element — no quoting/escaping is required because it never reaches a shell.
 */
export function buildOpencodeArgs(description: string): string[] {
	return ['--non-interactive', '--message', description];
}

export function buildVitestArgs(): string[] {
	return ['vitest', 'run', '--reporter=verbose'];
}

/**
 * Compose the commit message from an untrusted task description. The result is
 * passed verbatim as one `-m` argv element, so embedded shell metacharacters are
 * inert.
 */
export function buildCommitMessage(description: string): string {
	return `feat: ${description.slice(0, 72)}\n\nGenerated by Owlat code-worker`;
}

/**
 * Minimal environments for child processes that execute UNTRUSTED code.
 *
 * The OpenCode agent writes arbitrary files from an attacker-controlled
 * prompt, and `npx vitest run` then executes whatever it wrote (vitest
 * configs and test files run arbitrary Node at collection time). Neither
 * child may inherit the worker's secrets: with `...process.env` a
 * prompt-injected agent (or the code it wrote) could read GITHUB_TOKEN /
 * CONVEX_* / INTERNAL_* straight from its environment and exfiltrate them.
 *
 * - The agent gets ONLY the LLM endpoint credentials it needs to function.
 * - The test run gets NO credentials at all.
 * GITHUB_TOKEN stays in the parent (used via Octokit in github.ts) and the
 * parent-side git push; it is never handed to a child that runs task code.
 *
 * NOTE: this env-stripping is now DEFENCE-IN-DEPTH. The PRIMARY isolation is
 * that these children run under a SEPARATE unprivileged uid (SANDBOX_UID) from
 * the secret-holding orchestrator, so they cannot reach the orchestrator's
 * secrets via /proc/<orchestrator>/environ or by ptracing it even if a hostile
 * child tried — a cross-uid kernel boundary blocks both. Exported so the
 * no-secret invariant can be unit-tested.
 */
export function buildAgentEnv(
	workDir: string,
	parentEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
	return {
		PATH: parentEnv['PATH'],
		HOME: workDir,
		LLM_BASE_URL: parentEnv['LLM_BASE_URL'],
		LLM_API_KEY: parentEnv['LLM_API_KEY'],
	};
}

export function buildTestEnv(
	workDir: string,
	parentEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
	return {
		PATH: parentEnv['PATH'],
		HOME: workDir,
		CI: 'true',
	};
}

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
function handOffWorkspaceToSandbox(workDir: string): void {
	execFileSync('chown', ['-R', `${SANDBOX_UID}:${SANDBOX_GID}`, workDir], { stdio: 'inherit' });
	execFileSync('chown', ['-R', '0:0', path.join(workDir, '.git')], { stdio: 'inherit' });
}

/**
 * Remove a task workspace directory, ignoring errors. Called in a `finally` so a
 * per-task full clone is never leaked, whatever the task outcome.
 */
export function removeWorkspace(workDir: string): void {
	try {
		rmSync(workDir, { recursive: true, force: true });
	} catch {
		// Best-effort: a leftover dir will be reclaimed by pruneStaleWorkspaces on
		// the next startup.
	}
}

/**
 * Delete every task workspace under the root on startup. Each task does a full
 * clone into its own dir; before this they leaked forever across restarts, so a
 * fresh boot begins from a clean workspace root.
 */
export function pruneStaleWorkspaces(root: string = WORKSPACE_ROOT): void {
	if (!existsSync(root)) return;
	for (const entry of readdirSync(root)) {
		removeWorkspace(path.join(root, entry));
	}
}

/**
 * True if `<workDir>/.git` exists and is owned by root (uid 0).
 *
 * A reused workDir whose .git is NOT root-owned means a previous sandbox run
 * chowned it (or the tree is otherwise untrusted): trusted root git would then
 * hit a dubious-ownership refusal, and worse, a sandbox-owned .git could hide a
 * hostile hook. Such a dir must be discarded and re-cloned fresh, not pulled.
 */
function isGitDirRootOwned(workDir: string): boolean {
	try {
		return statSync(path.join(workDir, '.git')).uid === 0;
	} catch {
		return false;
	}
}

/**
 * Set up a git workspace for a task.
 *
 * Clones the repo (or, for a rare reused root-owned workDir, pulls latest),
 * creates a feature branch, then hands the WORKING TREE to the sandbox uid while
 * keeping .git root-owned — so the untrusted agent can write files but the
 * token-bearing git internals stay behind the uid boundary. All git commands
 * here are TRUSTED and run as root via runGit.
 */
function setupWorkspace(taskId: string): string {
	const workDir = path.join(WORKSPACE_ROOT, taskId);

	// #133 removes the workDir in `finally` + prunes on boot, so reuse is rare;
	// guard it anyway. If an existing workDir's .git is not root-owned (a prior
	// sandbox run touched it), discard it rather than run root git against a
	// sandbox-owned tree.
	if (existsSync(workDir) && !isGitDirRootOwned(workDir)) {
		log(`Discarding non-root-owned reused workspace ${workDir}`);
		removeWorkspace(workDir);
	}

	if (!existsSync(workDir)) {
		mkdirSync(workDir, { recursive: true });
		log(`Cloning repo into ${workDir}`);
		// Clone the tokenless URL; authenticate via the out-of-band header so no
		// credential is persisted into workDir/.git/config for the untrusted agent.
		runGit(buildCloneArgs(GIT_CLEAN_URL, GIT_BASE_BRANCH, workDir, GIT_AUTH_ARGS), {
			stdio: 'inherit',
		});
	} else {
		// Scrub any credential a prior (older) run may have left in origin, then pull.
		runGit(buildSetOriginUrlArgs(workDir, GIT_CLEAN_URL), { stdio: 'inherit' });
		log(`Pulling latest into ${workDir}`);
		runGit(buildPullArgs(workDir, GIT_BASE_BRANCH, GIT_AUTH_ARGS), { stdio: 'inherit' });
	}

	const branchName = buildBranchName(taskId);
	runGit(buildCheckoutArgs(workDir, branchName), { stdio: 'inherit' });

	// Hand the working tree to the sandbox uid (keeping .git root-owned) BEFORE
	// the untrusted agent runs, so it can write files it cannot otherwise reach.
	handOffWorkspaceToSandbox(workDir);

	return branchName;
}

/**
 * Run OpenCode (or a fallback coding agent) on the workspace.
 * OpenCode now supports Node.js, so we can spawn it as a subprocess.
 */
export async function runCodingAgent(
	workDir: string,
	description: string,
	spawnFn: typeof spawn = spawn
): Promise<{ success: boolean; output: string }> {
	const opencodeBin = process.env['OPENCODE_BIN'] ?? 'opencode';

	try {
		// UNTRUSTED: argv array + shell:false means the attacker-controlled
		// description can never break out into a shell command; runUntrusted also
		// drops the child to the sandbox uid so it cannot reach the orchestrator's
		// secrets. Detached so a timeout reaps the whole tree.
		const result = await runUntrusted(
			opencodeBin,
			buildOpencodeArgs(description),
			{
				cwd: workDir,
				timeoutMs: 600_000, // 10 minute timeout
				env: buildAgentEnv(workDir),
			},
			spawnFn
		);
		if (result.timedOut) {
			return {
				success: false,
				output: `OpenCode timed out after 10m; process group killed.\n${(result.stdout + result.stderr).slice(-2000)}`,
			};
		}
		if (result.code !== 0) {
			return {
				success: false,
				output:
					(result.stdout + result.stderr).slice(-2000) ||
					`OpenCode exited with code ${result.code}`,
			};
		}
		return { success: true, output: result.stdout };
	} catch (error) {
		const errMsg = error instanceof Error ? error.message : String(error);
		log(`OpenCode execution failed: ${errMsg}`);
		return { success: false, output: errMsg };
	}
}

/**
 * Run tests in the workspace.
 */
export async function runTests(
	workDir: string,
	spawnFn: typeof spawn = spawn
): Promise<{ passed: boolean; output: string }> {
	try {
		// UNTRUSTED: vitest configs + test files run arbitrary Node at collection
		// time, so this goes through runUntrusted (sandbox uid, shell:false, argv
		// array). Detached so a timeout kills vitest's whole worker pool, not just
		// the direct child.
		const result = await runUntrusted(
			'npx',
			buildVitestArgs(),
			{
				cwd: workDir,
				timeoutMs: 300_000, // 5 minute timeout
				env: buildTestEnv(workDir),
			},
			spawnFn
		);
		if (result.timedOut) {
			return {
				passed: false,
				output: `Tests timed out after 5m; process group killed.\n${(result.stdout + result.stderr).slice(-2000)}`,
			};
		}
		// vitest exits non-zero iff any test failed, so `passed` is derived purely
		// from exit status; `output` is captured for the PR body only and is never
		// parsed for the verdict.
		const combined = (result.stdout + result.stderr).trim();
		return { passed: result.code === 0, output: combined.slice(-2000) }; // Last 2000 chars
	} catch (error) {
		// spawn itself failed (e.g. npx missing) — treat as a test failure.
		const errMsg = error instanceof Error ? error.message : String(error);
		return { passed: false, output: errMsg.slice(-2000) };
	}
}

/**
 * Process a single code work task end-to-end.
 */
export async function processTask(task: CodeWorkTask): Promise<void> {
	const client = getConvexClient();
	const taskId = task._id;
	const workDir = path.join(WORKSPACE_ROOT, taskId);

	try {
		// 1. Claim the task
		log(`Claiming task ${taskId}`);
		const claimResult = await client.mutation(fn.claim, { taskId });
		if (!claimResult?.claimed) {
			log(`Task ${taskId} already claimed, skipping`);
			return;
		}

		// 2. Set up workspace & branch
		log(`Setting up workspace for ${taskId}`);
		const branchName = setupWorkspace(taskId);
		await client.mutation(fn.updateBranch, { taskId, branch: branchName });

		// 3. Run coding agent
		log(`Running coding agent for task: ${task.description}`);
		const agentResult = await runCodingAgent(workDir, task.description);

		if (!agentResult.success) {
			await client.mutation(fn.markFailed, {
				taskId,
				errorMessage: `Coding agent failed: ${agentResult.output.slice(0, 500)}`,
			});
			return;
		}

		// 4. Check if any files changed. Root git reads the sandbox-owned working
		// tree (world-readable) and writes only the root-owned .git.
		const diffOutput = runGit(buildDiffStatArgs(workDir), { encoding: 'utf-8' }) as string;
		if (!diffOutput.trim()) {
			await client.mutation(fn.markFailed, {
				taskId,
				errorMessage: 'Coding agent produced no changes',
			});
			return;
		}

		// 5. Commit changes. The commit message is built from the untrusted task
		// description and passed as a single `-m` argv element (shell:false).
		runGit(buildAddArgs(workDir), { stdio: 'inherit' });
		runGit(buildCommitArgs(workDir, buildCommitMessage(task.description)), {
			stdio: 'inherit',
		});

		// 6. Run tests
		log(`Running tests for ${taskId}`);
		await client.mutation(fn.markTesting, { taskId });
		const testResult = await runTests(workDir);

		// 7. Push and create PR. Auth is supplied out-of-band (GIT_AUTH_ARGS); the
		// untrusted agent + tests have already finished, and the token was never
		// written to workDir/.git/config.
		log(`Pushing branch ${branchName}`);
		runGit(buildPushArgs(workDir, branchName, GIT_AUTH_ARGS), { stdio: 'inherit' });

		let prUrl = '';
		if (GITHUB_OWNER && GITHUB_REPO) {
			log(`Creating PR for ${taskId}`);
			prUrl = await createPullRequest({
				owner: GITHUB_OWNER,
				repo: GITHUB_REPO,
				title: `[code-worker] ${task.description.slice(0, 60)}`,
				body: [
					'## Summary',
					'',
					task.description,
					'',
					'## Test Results',
					'',
					testResult.passed ? 'All tests passed.' : 'Some tests failed (see details below).',
					'',
					'```',
					testResult.output.slice(-1000),
					'```',
					'',
					'---',
					'Generated by Owlat code-worker',
				].join('\n'),
				head: branchName,
				base: GIT_BASE_BRANCH,
			});
		}

		// 8. Complete
		await client.mutation(fn.completeWithPR, {
			taskId,
			prUrl,
			testResults: testResult.output.slice(-2000),
		});

		log(`Task ${taskId} completed successfully${prUrl ? `: ${prUrl}` : ''}`);
	} catch (error) {
		const errMsg = error instanceof Error ? error.message : String(error);
		log(`Task ${taskId} failed: ${errMsg}`);

		try {
			await client.mutation(fn.markFailed, {
				taskId,
				errorMessage: errMsg.slice(0, 500),
			});
		} catch {
			log(`Failed to mark task ${taskId} as failed`);
		}
	} finally {
		// Always reclaim the workspace. The per-task clone is large and must never
		// leak — regardless of success, failure, or any early return above.
		removeWorkspace(workDir);
	}
}
