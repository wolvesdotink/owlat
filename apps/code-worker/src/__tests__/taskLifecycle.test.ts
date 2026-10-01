import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCodeTaskPoller, processTask, type ProcessTaskDeps } from '../taskProcess.js';
import { runCodingAgent } from '../taskRunner.js';
import {
	BRANCH,
	TASK_ID,
	createBackend,
	createGitHub,
	createRemote,
	isolateGitEnv,
	quietGit,
	taskDeps,
	untilAborted,
	type Backend,
	type Remote,
} from './codeTaskHarness.js';

/**
 * Fault and interleaving tests for the code-task run: cancellation is terminal
 * across agent, tests and publication (#934), and publication resumes after an
 * ambiguous failure instead of regenerating or duplicating (#936). Git runs
 * for real against a disposable bare remote; the agent, tests, backend and
 * GitHub are doubles (see codeTaskHarness.ts).
 */

let remote: Remote;
let backend: Backend;
let github: ReturnType<typeof createGitHub>;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	isolateGitEnv();
	logSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
	remote = createRemote();
	backend = createBackend();
	github = createGitHub();
});

afterEach(() => {
	remote.dispose();
	logSpy.mockRestore();
	vi.unstubAllEnvs();
});

function deps(overrides: Partial<ProcessTaskDeps> = {}): ProcessTaskDeps {
	return taskDeps(remote, backend, { pullRequests: github.api, ...overrides });
}

function workspaceGone(): boolean {
	return (
		!existsSync(path.join(remote.workspaceRoot, TASK_ID)) &&
		!existsSync(path.join(remote.workspaceRoot, `${TASK_ID}.home`))
	);
}

/** Git double that fails `push` before or after the remote applied it. */
function failingPush(
	when: 'before' | 'after',
	times = 1
): NonNullable<ProcessTaskDeps['workspaceOps']> {
	let left = times;
	const base = deps().workspaceOps!;
	return {
		...base,
		git: (args, opts) => {
			if (args.includes('push') && left > 0) {
				left -= 1;
				if (when === 'after') quietGit(args, opts);
				throw new Error(`push ${when === 'after' ? 'response lost' : 'connection reset'}`);
			}
			return quietGit(args, opts);
		},
	};
}

function expectCancelledUntouched() {
	expect(backend.row.status).toBe('failed');
	expect(backend.row.errorMessage).toBe('Cancelled by user');
	expect(backend.count('markFailed')).toBe(0);
}

describe('cancellation is terminal for a running task (#934)', () => {
	it('stops the agent run, reaches nothing after it and cleans the workspace', async () => {
		let reaped = false;
		const outcome = await processTask(
			backend.snapshot(),
			deps({
				runAgent: async (_workDir, _description, sandbox) => {
					backend.cancel();
					reaped = await untilAborted(sandbox.signal);
					return { success: false, output: 'killed' };
				},
			})
		);

		expect(outcome).toEqual({ acknowledged: true });
		expect(reaped).toBe(true);
		expectCancelledUntouched();
		expect(backend.count('markTesting')).toBe(0);
		expect(remote.branchSha()).toBeNull();
		expect(github.create).not.toHaveBeenCalled();
		expect(workspaceGone()).toBe(true);
	});

	it('stops the test run before the checkpoint and the push', async () => {
		let reaped = false;
		await processTask(
			backend.snapshot(),
			deps({
				runTests: async (_workDir, sandbox) => {
					backend.cancel();
					reaped = await untilAborted(sandbox.signal);
					return { passed: false, output: 'killed' };
				},
			})
		);

		expect(reaped).toBe(true);
		expectCancelledUntouched();
		expect(backend.count('recordPublication')).toBe(0);
		expect(backend.row.publishCommitSha).toBeUndefined();
		expect(remote.branchSha()).toBeNull();
		expect(github.create).not.toHaveBeenCalled();
		expect(workspaceGone()).toBe(true);
	});

	it('does not open a PR when the cancel lands right after the push', async () => {
		const base = deps().workspaceOps!;
		await processTask(
			backend.snapshot(),
			deps({
				workspaceOps: {
					...base,
					git: (args, opts) => {
						const out = quietGit(args, opts);
						if (args.includes('push')) backend.cancel();
						return out;
					},
				},
			})
		);

		expectCancelledUntouched();
		expect(github.create).not.toHaveBeenCalled();
		// The pushed branch is accounted for on the task by its checkpoint.
		expect(remote.branchSha()).toBe(backend.row.publishCommitSha);
		expect(backend.row.branch).toBe(BRANCH);
	});

	it('keeps the cancelled outcome and records a PR that raced the cancel', async () => {
		const create = github.api.create;
		github.api.create = async (details) => {
			const url = await create(details);
			backend.cancel();
			return url;
		};

		const outcome = await processTask(backend.snapshot(), deps());

		expect(outcome).toEqual({ acknowledged: true });
		expectCancelledUntouched();
		expect(backend.row.prUrl).toBe(github.prs[0]!.url);
		expect(github.prs).toHaveLength(1);
	});

	it('never starts a task cancelled while it was queued', async () => {
		const task = backend.snapshot();
		backend.cancel();
		const runAgent = vi.fn();

		await processTask(task, deps({ runAgent }));

		expect(runAgent).not.toHaveBeenCalled();
		expect(backend.row.attempts).toBe(0);
		expect(backend.row.status).toBe('failed');
	});

	it('stops an attempt superseded by a newer one without touching the newer one', async () => {
		let reaped = false;
		await processTask(
			backend.snapshot(),
			deps({
				runAgent: async (_workDir, _description, sandbox) => {
					backend.supersede();
					reaped = await untilAborted(sandbox.signal);
					return { success: false, output: 'killed' };
				},
			})
		);

		expect(reaped).toBe(true);
		expect(backend.row).toMatchObject({ status: 'running', attempts: 2 });
		expect(backend.count('markFailed')).toBe(0);
		expect(backend.count('markTesting')).toBe(0);
	});

	it('threads the cancellation signal into the sandbox run, which reaps it', async () => {
		const child = Object.assign(new EventEmitter(), {
			stdout: new EventEmitter(),
			stderr: new EventEmitter(),
		});
		const spawnFn = vi.fn((..._args: unknown[]) => child);
		const reap = vi.fn(() => {
			child.emit('close', null);
		});
		const controller = new AbortController();

		const run = runCodingAgent('/w', 'task', spawnFn as never, reap, {
			homeDir: '/w.home',
			signal: controller.signal,
		});
		controller.abort();
		const result = await run;

		expect(reap).toHaveBeenCalled();
		expect(result.success).toBe(false);
		expect(spawnFn.mock.calls[0]![2]).toMatchObject({ env: { HOME: '/w.home' } });
	});
});

describe('publication resumes after ambiguous failures (#936)', () => {
	it('regenerates when the push failed before reaching the remote', async () => {
		const runAgent = vi.fn(deps().runAgent!);
		await processTask(backend.snapshot(), deps({ runAgent, workspaceOps: failingPush('before') }));
		expect(backend.row.status).toBe('queued');
		expect(remote.branchSha()).toBeNull();

		await processTask(backend.snapshot(), deps({ runAgent }));

		expect(runAgent).toHaveBeenCalledTimes(2);
		expect(github.prs).toHaveLength(1);
		expect(backend.row).toMatchObject({ status: 'review', prUrl: github.prs[0]!.url });
		expect(remote.branchSha()).toBe(backend.row.publishCommitSha);
	});

	it('opens the PR from the pushed checkpoint when the push response was lost', async () => {
		const runAgent = vi.fn(deps().runAgent!);
		await processTask(backend.snapshot(), deps({ runAgent, workspaceOps: failingPush('after') }));
		const pushed = remote.branchSha();
		expect(pushed).toBe(backend.row.publishCommitSha);

		await processTask(backend.snapshot(), deps({ runAgent }));

		expect(runAgent).toHaveBeenCalledTimes(1);
		expect(remote.branchSha()).toBe(pushed);
		expect(github.prs).toHaveLength(1);
		expect(backend.row).toMatchObject({ status: 'review', prUrl: github.prs[0]!.url });
		expect(backend.row.testResults).toBe('3 passed');
	});

	it('binds the PR GitHub created when its response was lost, without a duplicate', async () => {
		github.faults.loseCreateResponse = 1;
		github.faults.findOutages = 0;
		// The lookup after the lost response fails too, so the attempt fails.
		const find = github.api.find;
		let findCalls = 0;
		github.api.find = async (head, base) => {
			findCalls += 1;
			if (findCalls === 2) throw new Error('GitHub unavailable');
			return find(head, base);
		};
		const runAgent = vi.fn(deps().runAgent!);
		await processTask(backend.snapshot(), deps({ runAgent }));
		expect(backend.row.status).toBe('queued');

		await processTask(backend.snapshot(), deps({ runAgent }));

		expect(runAgent).toHaveBeenCalledTimes(1);
		expect(github.create).toHaveBeenCalledTimes(1);
		expect(github.prs).toHaveLength(1);
		expect(backend.row).toMatchObject({ status: 'review', prUrl: github.prs[0]!.url });
	});

	it('recovers a lost PR response within the same attempt', async () => {
		github.faults.loseCreateResponse = 1;

		const outcome = await processTask(backend.snapshot(), deps());

		expect(outcome).toEqual({ acknowledged: true });
		expect(github.prs).toHaveLength(1);
		expect(backend.row).toMatchObject({ status: 'review', prUrl: github.prs[0]!.url });
	});

	it('repeats a completion whose response was lost', async () => {
		backend.lostResponses['completeWithPR'] = 1;

		const outcome = await processTask(backend.snapshot(), deps({ reportRetryDelaysMs: [0] }));

		expect(outcome).toEqual({ acknowledged: true });
		expect(backend.count('completeWithPR')).toBe(2);
		expect(backend.row).toMatchObject({ status: 'review', prUrl: github.prs[0]!.url });
	});

	it('recovers from a backend outage at completion without a restart', async () => {
		const runAgent = vi.fn(deps().runAgent!);
		const poll = createCodeTaskPoller(deps({ runAgent }));
		backend.outages['completeWithPR'] = 1;

		// The run publishes, but its completion never reaches the backend.
		await poll();
		expect(backend.row.status).toBe('testing');
		expect(github.prs).toHaveLength(1);

		// The backend is still down on the next poll: the reclaim stays owed.
		backend.outages['reclaimStale'] = 1;
		await expect(poll()).rejects.toThrow('backend unavailable');
		expect(backend.count('getNextQueued')).toBe(1);

		// Once it answers, the reclaim requeues the task and the next attempt
		// binds the PR that is already open.
		await poll();

		expect(runAgent).toHaveBeenCalledTimes(1);
		expect(github.prs).toHaveLength(1);
		expect(backend.row).toMatchObject({
			status: 'review',
			prUrl: github.prs[0]!.url,
			attempts: 2,
		});
	});

	it('leaves a remote branch it cannot account for untouched and says so', async () => {
		backend.row.attempts = 1;
		const foreign = remote.pushForeignCommit();
		const runAgent = vi.fn();

		await processTask(backend.snapshot(), deps({ runAgent }));

		expect(runAgent).not.toHaveBeenCalled();
		expect(remote.branchSha()).toBe(foreign);
		expect(github.create).not.toHaveBeenCalled();
		expect(backend.row.status).toBe('failed');
		expect(backend.row.errorMessage).toContain(
			`Remote branch ${BRANCH} is at ${foreign.slice(0, 12)}`
		);
		expect(backend.row.errorMessage).toContain('no recorded commit');
	});

	it('spends a reconcile-only claim without running the agent again', async () => {
		Object.assign(backend.row, { attempts: 3, publishCommitSha: 'f'.repeat(40) });
		const runAgent = vi.fn();

		await processTask(backend.snapshot(), deps({ runAgent }));

		expect(runAgent).not.toHaveBeenCalled();
		expect(backend.row.status).toBe('failed');
		expect(backend.row.errorMessage).toContain('could not be confirmed');
	});

	it('does not let a lost-response retry overwrite a cancel', async () => {
		const runAgent = vi.fn(deps().runAgent!);
		await processTask(backend.snapshot(), deps({ runAgent, workspaceOps: failingPush('after') }));
		backend.cancel();

		await processTask(backend.snapshot(), deps({ runAgent }));

		expect(backend.count('claim')).toBe(2);
		expect(runAgent).toHaveBeenCalledTimes(1);
		expect(github.create).not.toHaveBeenCalled();
		expect(backend.row.status).toBe('failed');
		expect(backend.row.errorMessage).toBe('Cancelled by user');
		expect(backend.row.prUrl).toBeUndefined();
	});
});
