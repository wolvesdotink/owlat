import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { reapSandboxProcesses, removeWorkspace, pruneStaleWorkspaces } from '../taskRunner.js';

describe('sandbox cleanup helper', () => {
	it('uses the sandbox uid and a credential-free environment to reap all its processes', async () => {
		const child = new EventEmitter();
		const spawn = vi.fn(() => child);
		const done = reapSandboxProcesses(spawn as never);
		child.emit('exit', 0);
		await done;
		const [command, args, options] = spawn.mock.calls[0]!;
		expect(command).toBe(process.execPath);
		expect(args).toEqual(['-e', expect.stringContaining("process.kill(-1, 'SIGKILL')")]);
		expect(options).toMatchObject({ uid: 10001, gid: 10001, env: {}, cwd: '/' });
	});

	it('stops the worker if sandbox cleanup fails instead of continuing with survivors', async () => {
		const spawn = vi.fn(() => {
			throw new Error('helper failed');
		});
		const fatal = vi.fn(() => {
			throw new Error('worker stopped');
		});
		await expect(reapSandboxProcesses(spawn as never, fatal)).rejects.toThrow('worker stopped');
		expect(fatal).toHaveBeenCalledWith(1);
	});

	it('stops the worker if hostile code prevents the helper from exiting', async () => {
		vi.useFakeTimers();
		try {
			const spawn = vi.fn(() => new EventEmitter());
			const fatal = vi.fn(() => {
				throw new Error('worker stopped');
			});
			const done = expect(reapSandboxProcesses(spawn as never, fatal)).rejects.toThrow(
				'worker stopped'
			);
			await vi.advanceTimersByTimeAsync(5_000);
			await done;
			expect(fatal).toHaveBeenCalledWith(1);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('workspace cleanup', () => {
	it('removeWorkspace deletes a task dir and its contents', () => {
		const root = mkdtempSync(path.join(tmpdir(), 'cw-cleanup-'));
		const workDir = path.join(root, 'task-abc');
		mkdirSync(path.join(workDir, 'nested'), { recursive: true });
		writeFileSync(path.join(workDir, 'nested', 'file.txt'), 'x');

		removeWorkspace(workDir);

		expect(existsSync(workDir)).toBe(false);
	});

	it('removeWorkspace does not throw for a non-existent dir', () => {
		expect(() => removeWorkspace(path.join(tmpdir(), 'cw-does-not-exist-xyz'))).not.toThrow();
	});

	it('pruneStaleWorkspaces clears every leftover task dir under the root', () => {
		const root = mkdtempSync(path.join(tmpdir(), 'cw-prune-'));
		for (const id of ['task-1', 'task-2', 'task-3']) {
			mkdirSync(path.join(root, id), { recursive: true });
			writeFileSync(path.join(root, id, 'clone.txt'), 'data');
		}

		pruneStaleWorkspaces(root);

		expect(readdirSync(root)).toEqual([]);
	});

	it('pruneStaleWorkspaces is a no-op when the root does not exist', () => {
		expect(() => pruneStaleWorkspaces(path.join(tmpdir(), 'cw-no-root-abc'))).not.toThrow();
	});
});
