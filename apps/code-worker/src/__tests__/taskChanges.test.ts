import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processTask, type ProcessTaskDeps } from '../taskProcess.js';
import {
	TASK_ID,
	createBackend,
	createRemote,
	git,
	isolateGitEnv,
	taskDeps,
	type Backend,
	type Remote,
} from './codeTaskHarness.js';

/**
 * #935: whether the agent changed anything is decided on what `git add -A`
 * stages, so new files, already-staged edits, deletions and renames all reach
 * commit, tests and publication, while an untouched tree or ignored output
 * alone stays a terminal no-op. Each case runs `processTask` against a real
 * disposable Git remote; only the agent, the tests and the backend are doubles.
 */

let remote: Remote;
let backend: Backend;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	isolateGitEnv();
	logSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
	remote = createRemote();
	backend = createBackend();
});

afterEach(() => {
	remote.dispose();
	logSpy.mockRestore();
	vi.unstubAllEnvs();
});

type Agent = NonNullable<ProcessTaskDeps['runAgent']>;

async function runWithAgent(agent: Agent) {
	const runTests = vi.fn(async () => ({ passed: true, output: '3 passed' }));
	const outcome = await processTask(
		backend.snapshot(),
		taskDeps(remote, backend, { runAgent: agent, runTests })
	);
	return { outcome, runTests };
}

function expectPublished(runTests: ReturnType<typeof vi.fn>) {
	expect(runTests).toHaveBeenCalledTimes(1);
	expect(remote.branchSha()).toBe(backend.row.publishCommitSha);
	expect(backend.row.status).toBe('review');
}

function expectNoOp(runTests: ReturnType<typeof vi.fn>) {
	expect(runTests).not.toHaveBeenCalled();
	expect(remote.branchSha()).toBeNull();
	expect(backend.row.status).toBe('failed');
	expect(backend.row.errorMessage).toBe('Coding agent produced no changes');
	expect(backend.calls.find((c) => c.name === 'markFailed')?.args).toMatchObject({
		terminal: true,
	});
}

describe('processTask change detection', () => {
	it('publishes a task whose only change is a new file', async () => {
		const { outcome, runTests } = await runWithAgent(async (workDir) => {
			writeFileSync(path.join(workDir, 'src', 'new.ts'), 'export const fresh = 1;\n');
			return { success: true, output: '' };
		});

		expect(outcome).toEqual({ acknowledged: true });
		expectPublished(runTests);
		expect(remote.files()).toContain('src/new.ts');
	});

	it('publishes an already-staged modification and an already-staged addition', async () => {
		const { runTests } = await runWithAgent(async (workDir) => {
			writeFileSync(path.join(workDir, 'src', 'a.ts'), 'export const a = 3;\n');
			writeFileSync(path.join(workDir, 'src', 'staged.ts'), 'export const staged = 1;\n');
			git(['add', 'src/a.ts', 'src/staged.ts'], workDir);
			return { success: true, output: '' };
		});

		expectPublished(runTests);
		expect(remote.files()).toContain('src/staged.ts');
		expect(remote.show('src/a.ts')).toBe('export const a = 3;\n');
	});

	it('publishes a tracked deletion', async () => {
		const { runTests } = await runWithAgent(async (workDir) => {
			rmSync(path.join(workDir, 'src', 'old.ts'));
			return { success: true, output: '' };
		});

		expectPublished(runTests);
		expect(remote.files()).not.toContain('src/old.ts');
	});

	it('publishes a rename', async () => {
		const { runTests } = await runWithAgent(async (workDir) => {
			renameSync(path.join(workDir, 'src', 'old.ts'), path.join(workDir, 'src', 'renamed.ts'));
			return { success: true, output: '' };
		});

		expectPublished(runTests);
		expect(remote.files()).toEqual(expect.arrayContaining(['src/renamed.ts']));
		expect(remote.files()).not.toContain('src/old.ts');
	});

	it('ends an unchanged tree as a terminal no-op and removes the workspace', async () => {
		const { outcome, runTests } = await runWithAgent(async () => ({ success: true, output: '' }));

		expect(outcome).toEqual({ acknowledged: true });
		expectNoOp(runTests);
		expect(existsSync(path.join(remote.workspaceRoot, TASK_ID))).toBe(false);
	});

	it('does not count ignored dependency or build output as a change', async () => {
		const { runTests } = await runWithAgent(async (workDir) => {
			mkdirSync(path.join(workDir, 'node_modules', 'left-pad'), { recursive: true });
			writeFileSync(path.join(workDir, 'node_modules', 'left-pad', 'index.js'), '');
			mkdirSync(path.join(workDir, 'dist'));
			writeFileSync(path.join(workDir, 'dist', 'bundle.js'), '');
			return { success: true, output: '' };
		});

		expectNoOp(runTests);
	});

	it('keeps the tools state the agent writes to HOME out of the repository', async () => {
		const { runTests } = await runWithAgent(async (workDir, _description, sandbox) => {
			expect(sandbox.homeDir).toBeDefined();
			expect(path.relative(workDir, sandbox.homeDir!).startsWith('..')).toBe(true);
			mkdirSync(path.join(sandbox.homeDir!, '.local', 'share', 'opencode'), { recursive: true });
			writeFileSync(path.join(sandbox.homeDir!, '.local', 'share', 'opencode', 'log'), 'x');
			return { success: true, output: '' };
		});

		expectNoOp(runTests);
		expect(existsSync(path.join(remote.workspaceRoot, `${TASK_ID}.home`))).toBe(false);
	});
});
