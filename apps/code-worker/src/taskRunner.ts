import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import {
	combinedOutputTail,
	runUntrusted,
	runGit,
	handOffWorkspaceToSandbox,
	chownDirToSandbox,
	isGitDirRootOwned,
} from './sandbox.js';
import { log } from './log.js';

// Re-export the sandbox-execution seam so existing importers (and the uid /
// process-isolation tests) keep resolving these symbols through taskRunner.
export {
	SANDBOX_UID,
	SANDBOX_GID,
	runUntrusted,
	runGit,
	reapSandboxProcesses,
	type DetachedRunResult,
} from './sandbox.js';

const WORKSPACE_ROOT = process.env['WORKSPACE_ROOT'] ?? '/workspace';

/** Where a task's repository lives and where it is published. */
export interface TaskRunnerConfig {
	workspaceRoot: string;
	/** Tokenless clone URL; the credential travels in `gitAuthEnv` only. */
	repoUrl: string;
	gitAuthEnv: NodeJS.ProcessEnv;
	baseBranch: string;
	githubOwner: string;
	githubRepo: string;
}

/**
 * Read the task configuration from the environment. The credential in
 * GIT_REPO_URL is NEVER written into the workspace .git/config (see
 * parseRepoUrl), and a malformed credential URL throws here.
 */
export function taskRunnerConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TaskRunnerConfig {
	const { cleanUrl, authEnv } = parseRepoUrl(env['GIT_REPO_URL'] ?? '');
	return {
		workspaceRoot: env['WORKSPACE_ROOT'] ?? '/workspace',
		repoUrl: cleanUrl,
		gitAuthEnv: authEnv,
		baseBranch: env['GIT_BASE_BRANCH'] ?? 'main',
		githubOwner: env['GITHUB_OWNER'] ?? '',
		githubRepo: env['GITHUB_REPO'] ?? '',
	};
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
/** Remove URL credentials and pass Git authentication only through its environment.
 * Unlike /proc/<pid>/environ, root-owned /proc/<pid>/cmdline is readable by the
 * sandbox uid. Never put an Authorization header in Git's argv or disk config.
 */
export function parseRepoUrl(repoUrl: string): { cleanUrl: string; authEnv: NodeJS.ProcessEnv } {
	try {
		const u = new URL(repoUrl);
		if (u.username || u.password) {
			const userinfo = `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`;
			const basic = Buffer.from(userinfo).toString('base64');
			u.username = '';
			u.password = '';
			return {
				cleanUrl: u.toString(),
				authEnv: {
					GIT_CONFIG_COUNT: '1',
					GIT_CONFIG_KEY_0: 'http.extraheader',
					GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
				},
			};
		}
	} catch {
		// Fail closed: a malformed credential URL must never reach Git's argv.
		if (repoUrl.includes('://')) throw new Error('Invalid Git repository URL');
	}
	return { cleanUrl: repoUrl, authEnv: {} };
}

export function buildCloneArgs(repoUrl: string, baseBranch: string, workDir: string): string[] {
	return ['clone', '--depth', '1', '--branch', baseBranch, repoUrl, workDir];
}

export function buildPullArgs(workDir: string, baseBranch: string): string[] {
	return ['-C', workDir, 'pull', 'origin', baseBranch];
}

/** Force `origin` to a (tokenless) URL — scrubs any credential a prior run may
 * have persisted into a reused workspace's .git/config. */
export function buildSetOriginUrlArgs(workDir: string, url: string): string[] {
	return ['-C', workDir, 'remote', 'set-url', 'origin', url];
}

export function buildCheckoutArgs(workDir: string, branchName: string): string[] {
	return ['-C', workDir, 'checkout', '-b', branchName];
}

export function buildAddArgs(workDir: string): string[] {
	return ['-C', workDir, 'add', '-A'];
}

/**
 * The change predicate: paths whose staged content differs from HEAD, NUL
 * separated, run right after `git add -A`. Staging first is what makes it see
 * new files, already-staged edits, deletions and renames, and what keeps
 * ignored files out: `add -A` honours .gitignore, so dependency and build
 * output never count as a change. The agent cannot commit (the repository
 * metadata is root-owned), so HEAD is still the base commit.
 */
export function buildStagedChangesArgs(workDir: string): string[] {
	return ['-C', workDir, 'diff', '--cached', '--name-only', '-z'];
}

export function buildHeadShaArgs(workDir: string): string[] {
	return ['-C', workDir, 'rev-parse', 'HEAD'];
}

/** Look up one branch on the remote without a workspace: `<sha>\trefs/heads/<branch>`. */
export function buildRemoteBranchArgs(repoUrl: string, branchName: string): string[] {
	return ['ls-remote', '--heads', repoUrl, `refs/heads/${branchName}`];
}

export function buildCommitArgs(workDir: string, message: string): string[] {
	return ['-C', workDir, 'commit', '-m', message];
}

export function buildPushArgs(workDir: string, branchName: string): string[] {
	return ['-C', workDir, 'push', 'origin', branchName];
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
 * `homeDir` is the task's scratch home beside the repository (see
 * `setupWorkspace`), never the repository itself.
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
	homeDir: string,
	parentEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
	return {
		PATH: parentEnv['PATH'],
		HOME: homeDir,
		LLM_BASE_URL: parentEnv['LLM_BASE_URL'],
		LLM_API_KEY: parentEnv['LLM_API_KEY'],
	};
}

export function buildTestEnv(
	homeDir: string,
	parentEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
	return {
		PATH: parentEnv['PATH'],
		HOME: homeDir,
		CI: 'true',
	};
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

/** A task's directories: the repository clone and the children's scratch home. */
interface TaskWorkspace {
	workDir: string;
	homeDir: string;
	branchName: string;
}

export function taskWorkspacePaths(workspaceRoot: string, taskId: string) {
	return {
		workDir: path.join(workspaceRoot, taskId),
		homeDir: path.join(workspaceRoot, `${taskId}.home`),
	};
}

/** Filesystem steps of `setupWorkspace`, injectable so tests need no root. */
export interface WorkspaceOps {
	git: (args: string[], opts?: Parameters<typeof runGit>[1]) => string | Buffer;
	/** Hand the working tree to the sandbox uid, keeping .git root-owned. */
	handOffTree: (workDir: string) => void;
	/** Create the sandbox-writable scratch home. */
	prepareHome: (homeDir: string) => void;
}

export const defaultWorkspaceOps: WorkspaceOps = {
	git: (args, opts) => runGit(args, opts),
	handOffTree: handOffWorkspaceToSandbox,
	prepareHome: (homeDir) => {
		mkdirSync(homeDir, { recursive: true });
		chownDirToSandbox(homeDir);
	},
};

/**
 * Set up a git workspace for a task.
 *
 * Clones the repo (or, for a rare reused root-owned workDir, pulls latest),
 * creates a feature branch, then hands the WORKING TREE to the sandbox uid while
 * keeping .git root-owned — so the untrusted agent can write files but the
 * token-bearing git internals stay behind the uid boundary. All git commands
 * here are TRUSTED and run as root via runGit.
 *
 * The children get a HOME outside the repository. Tool state the agent writes
 * there (caches, session logs, config) would otherwise be untracked files in
 * the tree, which the change check and `git add -A` would count as the agent's
 * work.
 */
export function setupWorkspace(
	taskId: string,
	config: TaskRunnerConfig,
	ops: WorkspaceOps = defaultWorkspaceOps
): TaskWorkspace {
	const { workDir, homeDir } = taskWorkspacePaths(config.workspaceRoot, taskId);

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
		ops.git(buildCloneArgs(config.repoUrl, config.baseBranch, workDir), {
			stdio: 'inherit',
			env: { ...process.env, ...config.gitAuthEnv },
		});
	} else {
		// Scrub any credential a prior (older) run may have left in origin, then pull.
		ops.git(buildSetOriginUrlArgs(workDir, config.repoUrl), { stdio: 'inherit' });
		log(`Pulling latest into ${workDir}`);
		ops.git(buildPullArgs(workDir, config.baseBranch), {
			stdio: 'inherit',
			env: { ...process.env, ...config.gitAuthEnv },
		});
	}

	const branchName = buildBranchName(taskId);
	ops.git(buildCheckoutArgs(workDir, branchName), { stdio: 'inherit' });

	// Hand the working tree to the sandbox uid (keeping .git root-owned) BEFORE
	// the untrusted agent runs, so it can write files it cannot otherwise reach.
	ops.handOffTree(workDir);
	ops.prepareHome(homeDir);

	return { workDir, homeDir, branchName };
}

/**
 * Per-run sandbox options: the scratch HOME, and the task's cancellation signal,
 * which reaps every sandbox process (detached grandchildren included) the
 * moment the task is cancelled or superseded.
 */
export interface SandboxTaskOptions {
	homeDir?: string;
	signal?: AbortSignal;
}

/**
 * Run OpenCode (or a fallback coding agent) on the workspace.
 * OpenCode now supports Node.js, so we can spawn it as a subprocess.
 */
export async function runCodingAgent(
	workDir: string,
	description: string,
	spawnFn: typeof spawn = spawn,
	reap?: () => void | Promise<void>,
	sandbox: SandboxTaskOptions = {}
): Promise<{ success: boolean; output: string }> {
	const opencodeBin = process.env['OPENCODE_BIN'] ?? 'opencode';

	try {
		// UNTRUSTED: argv array + shell:false means the attacker-controlled
		// description can never break out into a shell command; runUntrusted also
		// drops the child to the sandbox uid so it cannot reach the orchestrator's
		// secrets. Cleanup reaps every process using the sandbox uid.
		const result = await runUntrusted(
			opencodeBin,
			buildOpencodeArgs(description),
			{
				cwd: workDir,
				timeoutMs: 600_000, // 10 minute timeout
				env: buildAgentEnv(sandbox.homeDir ?? workDir),
				signal: sandbox.signal,
				reap,
			},
			spawnFn
		);
		if (result.timedOut) {
			const header = 'OpenCode timed out after 10m; sandbox processes killed.\n';
			return {
				success: false,
				output: header + combinedOutputTail(result, 2000 - header.length),
			};
		}
		if (result.code !== 0) {
			return {
				success: false,
				output: combinedOutputTail(result, 2000) || `OpenCode exited with code ${result.code}`,
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
	spawnFn: typeof spawn = spawn,
	reap?: () => void | Promise<void>,
	sandbox: SandboxTaskOptions = {}
): Promise<{ passed: boolean; output: string }> {
	try {
		// UNTRUSTED: vitest configs + test files run arbitrary Node at collection
		// time, so this goes through runUntrusted (sandbox uid, shell:false, argv
		// array). Cleanup includes detached workers and runs after every exit.
		const result = await runUntrusted(
			'npx',
			buildVitestArgs(),
			{
				cwd: workDir,
				timeoutMs: 300_000, // 5 minute timeout
				env: buildTestEnv(sandbox.homeDir ?? workDir),
				signal: sandbox.signal,
				reap,
			},
			spawnFn
		);
		if (result.timedOut) {
			// Header and tail together fit the 2000 characters the task record keeps.
			const header = 'Tests timed out after 5m; sandbox processes killed.\n';
			return {
				passed: false,
				output: header + combinedOutputTail(result, 2000 - header.length),
			};
		}
		// vitest exits non-zero iff any test failed, so `passed` is derived purely
		// from exit status; `output` is captured for the PR body only and is never
		// parsed for the verdict.
		return { passed: result.code === 0, output: combinedOutputTail(result, 2000) };
	} catch (error) {
		// spawn itself failed (e.g. npx missing) — treat as a test failure.
		const errMsg = error instanceof Error ? error.message : String(error);
		return { passed: false, output: errMsg.slice(-2000) };
	}
}
