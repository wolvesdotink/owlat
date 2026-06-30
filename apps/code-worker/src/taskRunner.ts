import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
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

export function buildCloneArgs(repoUrl: string, baseBranch: string, workDir: string, authArgs: string[] = []): string[] {
	return [...authArgs, 'clone', '--depth', '1', '--branch', baseBranch, repoUrl, workDir];
}

export function buildPullArgs(workDir: string, baseBranch: string, authArgs: string[] = []): string[] {
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

export function buildPushArgs(workDir: string, branchName: string, authArgs: string[] = []): string[] {
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
 * Exported so the no-secret invariant can be unit-tested.
 */
export function buildAgentEnv(workDir: string, parentEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	return {
		PATH: parentEnv['PATH'],
		HOME: workDir,
		LLM_BASE_URL: parentEnv['LLM_BASE_URL'],
		LLM_API_KEY: parentEnv['LLM_API_KEY'],
	};
}

export function buildTestEnv(workDir: string, parentEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	return {
		PATH: parentEnv['PATH'],
		HOME: workDir,
		CI: 'true',
	};
}

/**
 * Set up a git workspace for a task.
 * Clones the repo (or pulls latest) and creates a feature branch.
 */
function setupWorkspace(taskId: string): string {
	const workDir = path.join(WORKSPACE_ROOT, taskId);

	if (!existsSync(workDir)) {
		mkdirSync(workDir, { recursive: true });
		log(`Cloning repo into ${workDir}`);
		// Clone the tokenless URL; authenticate via the out-of-band header so no
		// credential is persisted into workDir/.git/config for the untrusted agent.
		execFileSync('git', buildCloneArgs(GIT_CLEAN_URL, GIT_BASE_BRANCH, workDir, GIT_AUTH_ARGS), {
			stdio: 'inherit',
		});
	} else {
		// Scrub any credential a prior (older) run may have left in origin, then pull.
		execFileSync('git', buildSetOriginUrlArgs(workDir, GIT_CLEAN_URL), { stdio: 'inherit' });
		log(`Pulling latest into ${workDir}`);
		execFileSync('git', buildPullArgs(workDir, GIT_BASE_BRANCH, GIT_AUTH_ARGS), { stdio: 'inherit' });
	}

	const branchName = buildBranchName(taskId);
	execFileSync('git', buildCheckoutArgs(workDir, branchName), { stdio: 'inherit' });

	return branchName;
}

/**
 * Run OpenCode (or a fallback coding agent) on the workspace.
 * OpenCode now supports Node.js, so we can spawn it as a subprocess.
 */
async function runCodingAgent(workDir: string, description: string): Promise<{ success: boolean; output: string }> {
	const opencodeBin = process.env['OPENCODE_BIN'] ?? 'opencode';

	try {
		// Try to use OpenCode if available. Argv array + shell:false means the
		// untrusted description can never break out into a shell command.
		const result = execFileSync(opencodeBin, buildOpencodeArgs(description), {
			cwd: workDir,
			timeout: 600_000, // 10 minute timeout
			encoding: 'utf-8',
			env: buildAgentEnv(workDir),
		});
		return { success: true, output: result };
	} catch (error) {
		const errMsg = error instanceof Error ? error.message : String(error);
		log(`OpenCode execution failed: ${errMsg}`);
		return { success: false, output: errMsg };
	}
}

/**
 * Run tests in the workspace.
 */
function runTests(workDir: string): { passed: boolean; output: string } {
	try {
		// `shell: false`: invoke npx directly with an argv array. Failures are
		// caught below instead of being swallowed by a shell `|| true`.
		const output = execFileSync('npx', buildVitestArgs(), {
			cwd: workDir,
			timeout: 300_000, // 5 minute timeout
			encoding: 'utf-8',
			stdio: ['ignore', 'pipe', 'pipe'],
			env: buildTestEnv(workDir),
		});
		// `execFileSync` only returns here on a zero exit code, and vitest exits
		// non-zero iff any test failed — so reaching this branch *is* the pass
		// signal. `passed` is derived purely from exit status (the catch block
		// owns the failure path); `output` is captured for the PR body only and
		// is never parsed for the verdict.
		return { passed: true, output: output.slice(-2000) }; // Last 2000 chars
	} catch (error) {
		// vitest exits non-zero when tests fail; capture its combined output.
		const stdout =
			error && typeof error === 'object' && 'stdout' in error
				? String((error as { stdout?: unknown }).stdout ?? '')
				: '';
		const stderr =
			error && typeof error === 'object' && 'stderr' in error
				? String((error as { stderr?: unknown }).stderr ?? '')
				: '';
		const combined = (stdout + stderr).trim();
		return {
			passed: false,
			output: (combined || (error instanceof Error ? error.message : String(error))).slice(-2000),
		};
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

		// 4. Check if any files changed
		const diffOutput = execFileSync('git', buildDiffStatArgs(workDir), { encoding: 'utf-8' });
		if (!diffOutput.trim()) {
			await client.mutation(fn.markFailed, {
				taskId,
				errorMessage: 'Coding agent produced no changes',
			});
			return;
		}

		// 5. Commit changes. The commit message is built from the untrusted task
		// description and passed as a single `-m` argv element (shell:false).
		execFileSync('git', buildAddArgs(workDir), { stdio: 'inherit' });
		execFileSync('git', buildCommitArgs(workDir, buildCommitMessage(task.description)), {
			stdio: 'inherit',
		});

		// 6. Run tests
		log(`Running tests for ${taskId}`);
		await client.mutation(fn.markTesting, { taskId });
		const testResult = runTests(workDir);

		// 7. Push and create PR. Auth is supplied out-of-band (GIT_AUTH_ARGS); the
		// untrusted agent + tests have already finished, and the token was never
		// written to workDir/.git/config.
		log(`Pushing branch ${branchName}`);
		execFileSync('git', buildPushArgs(workDir, branchName, GIT_AUTH_ARGS), { stdio: 'inherit' });

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
	}
}
