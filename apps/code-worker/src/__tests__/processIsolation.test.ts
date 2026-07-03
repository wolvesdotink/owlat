import { describe, it, expect, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { killProcessGroup, removeWorkspace, pruneStaleWorkspaces } from '../taskRunner.js';

/**
 * The code-worker executes UNTRUSTED, inbound-email-driven code. Two invariants
 * from the hardening pass are exercised here without spawning real processes:
 *  - a timeout must reap the WHOLE process group (negative pid), not just the
 *    direct child, or a detached vitest worker pool survives the timeout;
 *  - the per-task clone must never leak — it is removed after each task and any
 *    stragglers are pruned on startup.
 */
describe('killProcessGroup', () => {
	it('signals the negative pid so the whole process group is reaped', () => {
		const kill = vi.fn();
		killProcessGroup(4321, kill);
		expect(kill).toHaveBeenCalledTimes(1);
		expect(kill).toHaveBeenCalledWith(-4321, 'SIGKILL');
	});

	it.each([undefined, 0, -1])('is a no-op for a missing/invalid pid: %s', (pid) => {
		const kill = vi.fn();
		killProcessGroup(pid as number | undefined, kill);
		expect(kill).not.toHaveBeenCalled();
	});

	it('swallows errors when the group has already exited (ESRCH)', () => {
		const kill = vi.fn(() => {
			throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
		});
		expect(() => killProcessGroup(999999, kill)).not.toThrow();
		expect(kill).toHaveBeenCalledWith(-999999, 'SIGKILL');
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
