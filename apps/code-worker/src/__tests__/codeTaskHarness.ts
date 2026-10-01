import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getFunctionName } from 'convex/server';
import { vi } from 'vitest';
import type { CodeWorkTask, CodeTaskWorkerVerdict } from '../convexClient.js';
import type { PullRequestApi } from '../publication.js';
import type { ProcessTaskDeps } from '../taskProcess.js';
import { runGit } from '../sandbox.js';

/**
 * Test harness for `processTask`: a disposable bare Git remote, an in-memory
 * stand-in for the `codeWorkTasks` functions and a fake GitHub. The backend
 * double follows the rules of apps/api `codeWorkTasks.ts` and
 * `lib/codeTaskFence.ts` (whose own integration suite runs them for real):
 * attempt/cancel fencing, the retry ceiling with its publication grace, and
 * idempotent completion. Only one task row is modelled.
 */

export const TASK_ID = 'task_abc123';
export const BRANCH = `code-worker/${TASK_ID}`;

/** Git without the developer's global config (signing, hooks, identity). */
export function isolateGitEnv(): void {
	vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
	vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
	vi.stubEnv('GIT_AUTHOR_NAME', 'Owlat Test');
	vi.stubEnv('GIT_AUTHOR_EMAIL', 'code-worker@example.com');
	vi.stubEnv('GIT_COMMITTER_NAME', 'Owlat Test');
	vi.stubEnv('GIT_COMMITTER_EMAIL', 'code-worker@example.com');
}

export function git(args: string[], cwd?: string): string {
	return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** A bare remote whose `main` holds a small project with a .gitignore. */
export function createRemote() {
	const root = mkdtempSync(path.join(tmpdir(), 'code-task-'));
	const bare = path.join(root, 'remote.git');
	git(['init', '--bare', '-q', '-b', 'main', bare]);
	const seed = path.join(root, 'seed');
	git(['init', '-q', '-b', 'main', seed]);
	mkdirSync(path.join(seed, 'src'));
	writeFileSync(path.join(seed, '.gitignore'), 'node_modules/\ndist/\n');
	writeFileSync(path.join(seed, 'README.md'), '# widgets\n');
	writeFileSync(path.join(seed, 'src', 'a.ts'), 'export const a = 1;\n');
	writeFileSync(path.join(seed, 'src', 'old.ts'), 'export const old = 1;\n');
	git(['add', '-A'], seed);
	git(['commit', '-q', '-m', 'base'], seed);
	git(['push', '-q', bare, 'main'], seed);

	return {
		root,
		url: `file://${bare}`,
		workspaceRoot: path.join(root, 'workspace'),
		/** Tip of `branch` on the remote, or null. */
		branchSha(branch = BRANCH): string | null {
			const out = git(['ls-remote', '--heads', bare, `refs/heads/${branch}`]).trim();
			return out ? out.split(/\s+/)[0]! : null;
		},
		/** Files in the tree at the tip of `branch` on the remote. */
		files(branch = BRANCH): string[] {
			return git(['--git-dir', bare, 'ls-tree', '-r', '--name-only', branch])
				.split('\n')
				.filter(Boolean);
		},
		/** Content of `file` at the tip of `branch` on the remote. */
		show(file: string, branch = BRANCH): string {
			return git(['--git-dir', bare, 'show', `${branch}:${file}`]);
		},
		/** Push a commit nobody recorded to `branch`, as a person might. */
		pushForeignCommit(branch = BRANCH): string {
			writeFileSync(path.join(seed, 'manual.ts'), 'export const manual = 1;\n');
			git(['add', '-A'], seed);
			git(['commit', '-q', '-m', 'manual change'], seed);
			git(['push', '-q', bare, `HEAD:refs/heads/${branch}`], seed);
			return git(['rev-parse', 'HEAD'], seed).trim();
		},
		dispose() {
			rmSync(root, { recursive: true, force: true });
		},
	};
}

export type Remote = ReturnType<typeof createRemote>;

interface Row {
	_id: string;
	description: string;
	status: CodeWorkTask['status'];
	attempts: number;
	maxAttempts: number;
	branch?: string;
	prUrl?: string;
	testResults?: string;
	errorMessage?: string;
	cancelledAt?: number;
	publishCommitSha?: string;
	createdAt: number;
	updatedAt: number;
}

export function createBackend(initial: Partial<Row> = {}) {
	const row: Row = {
		_id: TASK_ID,
		description: 'Add a widget endpoint',
		status: 'queued',
		attempts: 0,
		maxAttempts: 3,
		createdAt: 0,
		updatedAt: 0,
		...initial,
	};
	const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
	/** Calls that fail before the backend applies them. */
	const outages: Record<string, number> = {};
	/** Calls the backend applies whose response never reaches the worker. */
	const lostResponses: Record<string, number> = {};

	const verdict = (attempt: unknown): CodeTaskWorkerVerdict => {
		if (row.cancelledAt !== undefined) return { ok: false, reason: 'cancelled' };
		if (attempt !== undefined && attempt !== row.attempts) return { ok: false, reason: 'stale' };
		if (row.status !== 'running' && row.status !== 'testing') {
			return { ok: false, reason: 'finished' };
		}
		return { ok: true };
	};
	const guarded = (args: Record<string, unknown>, apply: () => void) => {
		const v = verdict(args['attempt']);
		if (v.ok) apply();
		return v;
	};
	const mayRetry = () => row.attempts < row.maxAttempts + (row.publishCommitSha ? 1 : 0);

	const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
		getNextQueued: () => (row.status === 'queued' ? { ...row } : null),
		claim: () => {
			if (row.status !== 'queued') return { claimed: false };
			row.attempts += 1;
			row.status = 'running';
			return { claimed: true, attempt: row.attempts, mayRunAgent: row.attempts <= row.maxAttempts };
		},
		checkAttempt: (args) => verdict(args['attempt']),
		updateBranch: (args) => guarded(args, () => (row.branch = args['branch'] as string)),
		markTesting: (args) => guarded(args, () => (row.status = 'testing')),
		recordPublication: (args) =>
			guarded(args, () => {
				row.branch = args['branch'] as string;
				row.publishCommitSha = args['commitSha'] as string;
				row.testResults = args['testResults'] as string;
			}),
		completeWithPR: (args) => {
			const v = verdict(args['attempt']);
			const prUrl = args['prUrl'] as string;
			if (!v.ok) {
				if (v.reason === 'cancelled' && prUrl) row.prUrl = prUrl;
				return v.reason === 'finished' && row.status === 'review' && row.prUrl === prUrl
					? { ok: true }
					: v;
			}
			row.status = 'review';
			row.prUrl = prUrl;
			row.testResults = (args['testResults'] as string | undefined) ?? row.testResults;
			return v;
		},
		markFailed: (args) => {
			const v = verdict(args['attempt']);
			if (!v.ok) {
				return { status: 'failed', retried: false, attempts: row.attempts, ignored: v.reason };
			}
			row.errorMessage = args['errorMessage'] as string;
			if (!args['terminal'] && mayRetry()) {
				row.status = 'queued';
				return { status: 'queued', retried: true, attempts: row.attempts, nextAttemptAt: 0 };
			}
			row.status = 'failed';
			return { status: 'failed', retried: false, attempts: row.attempts };
		},
		reclaimStale: () => {
			if (row.status !== 'running' && row.status !== 'testing') return { reclaimed: 0 };
			row.status = mayRetry() ? 'queued' : 'failed';
			row.errorMessage = 'Worker restarted mid-run; task reclaimed';
			return { reclaimed: 1 };
		},
	};

	const call = async (reference: unknown, args: Record<string, unknown>) => {
		const name = getFunctionName(reference as never)
			.split(':')
			.pop()!;
		calls.push({ name, args });
		if ((outages[name] ?? 0) > 0) {
			outages[name]! -= 1;
			throw new Error(`${name}: backend unavailable`);
		}
		const result = handlers[name]!(args);
		if ((lostResponses[name] ?? 0) > 0) {
			lostResponses[name]! -= 1;
			throw new Error(`${name}: response lost`);
		}
		return result;
	};

	return {
		row,
		calls,
		outages,
		lostResponses,
		client: { query: call, mutation: call } as unknown as NonNullable<ProcessTaskDeps['client']>,
		/** The queued row as `getNextQueued` hands it to the worker. */
		snapshot: () => ({ ...row }) as CodeWorkTask,
		/** The user-facing `cancel`. */
		cancel() {
			row.status = 'failed';
			row.errorMessage = 'Cancelled by user';
			row.cancelledAt = Date.now();
		},
		/** A reclaim requeued the run and a newer attempt claimed it. */
		supersede() {
			row.attempts += 1;
			row.status = 'running';
		},
		count: (name: string) => calls.filter((c) => c.name === name).length,
	};
}

export type Backend = ReturnType<typeof createBackend>;

export function createGitHub() {
	const prs: Array<{ head: string; base: string; url: string }> = [];
	const faults = { loseCreateResponse: 0, findOutages: 0 };
	const find = vi.fn(async (head: string, base: string) => {
		if (faults.findOutages > 0) {
			faults.findOutages -= 1;
			throw new Error('GitHub unavailable');
		}
		return prs.filter((pr) => pr.head === head && pr.base === base).at(-1)?.url ?? null;
	});
	const create = vi.fn(async (details: { head: string; base: string }) => {
		if (prs.some((pr) => pr.head === details.head && pr.base === details.base)) {
			throw new Error('Validation Failed: A pull request already exists');
		}
		const url = `https://github.com/acme/widgets/pull/${prs.length + 1}`;
		prs.push({ head: details.head, base: details.base, url });
		if (faults.loseCreateResponse > 0) {
			faults.loseCreateResponse -= 1;
			throw new Error('socket hang up');
		}
		return url;
	});
	const api: PullRequestApi = { find, create };
	return { prs, faults, api, find, create };
}

/** Wait until `signal` aborts (the sandbox would be reaped), or give up. */
export function untilAborted(signal: AbortSignal | undefined, ms = 2_000): Promise<boolean> {
	return new Promise((resolve) => {
		if (!signal) return resolve(false);
		if (signal.aborted) return resolve(true);
		const timer = setTimeout(() => resolve(false), ms);
		signal.addEventListener('abort', () => {
			clearTimeout(timer);
			resolve(true);
		});
	});
}

/** Git that runs for real, with its output captured rather than inherited. */
export const quietGit: NonNullable<ProcessTaskDeps['workspaceOps']>['git'] = (args, opts = {}) =>
	runGit(args, { ...opts, stdio: opts.stdio === 'inherit' ? 'pipe' : opts.stdio });

export function taskDeps(
	remote: Remote,
	backend: Backend,
	overrides: Partial<ProcessTaskDeps> = {}
): ProcessTaskDeps {
	return {
		client: backend.client,
		config: {
			workspaceRoot: remote.workspaceRoot,
			repoUrl: remote.url,
			gitAuthEnv: {},
			baseBranch: 'main',
			githubOwner: '',
			githubRepo: '',
		},
		workspaceOps: {
			git: quietGit,
			// No uid boundary in tests: the tree stays owned by the test user.
			handOffTree: () => {},
			prepareHome: (homeDir) => mkdirSync(homeDir, { recursive: true }),
		},
		runAgent: async (workDir) => {
			writeFileSync(path.join(workDir, 'src', 'a.ts'), 'export const a = 2;\n');
			return { success: true, output: '' };
		},
		runTests: async () => ({ passed: true, output: '3 passed' }),
		pullRequests: null,
		attemptCheckMs: 5,
		reportRetryDelaysMs: [],
		...overrides,
	};
}
