/**
 * How `bun run dev:stack` stops its foreground processes
 * (scripts/dev-stack/supervise.ts), with real process groups: whatever a
 * launcher spawned is stopped too, even after the launcher itself is gone.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { supervise, type ChildSpec } from '../dev-stack/supervise';

const dirs: string[] = [];
const strays: number[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), 'dev-stack-supervise-test-'));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const pid of strays.splice(0)) {
		try {
			process.kill(pid, 'SIGKILL');
		} catch {
			// already gone, which is what the tests expect
		}
	}
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function isRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

function shell(name: string, script: string, cwd: string): ChildSpec {
	return { name, command: 'sh', args: ['-c', script], cwd, env: process.env };
}

function readPid(file: string): number {
	const pid = Number.parseInt(readFileSync(file, 'utf8'), 10);
	strays.push(pid);
	return pid;
}

const fast = { graceMs: 300, pollMs: 10, killSettleMs: 2_000 };

describe('supervise', () => {
	it('stops what a launcher left behind after the launcher exited', async () => {
		const dir = tempDir();
		const stops: number[] = [];
		const code = await supervise(
			[
				shell('launcher', 'sleep 60 & echo $! > child.pid; exit 0', dir),
				shell('other', 'echo $$ > other.pid; exec sleep 60', dir),
			],
			() => stops.push(1),
			fast
		);
		expect(code).toBe(1);
		expect(stops).toEqual([1]);
		expect(isRunning(readPid(join(dir, 'child.pid')))).toBe(false);
		expect(isRunning(readPid(join(dir, 'other.pid')))).toBe(false);
	});

	it('escalates to SIGKILL for a leftover that ignores SIGTERM after every leader is gone', async () => {
		const dir = tempDir();
		const code = await supervise(
			[shell('launcher', `trap '' TERM; sleep 60 & echo $! > child.pid; exit 3`, dir)],
			() => {},
			fast
		);
		expect(code).toBe(3);
		expect(isRunning(readPid(join(dir, 'child.pid')))).toBe(false);
	});

	it('reports a launcher that could not start', async () => {
		const dir = tempDir();
		const code = await supervise(
			[{ name: 'missing', command: join(dir, 'no-such-binary'), args: [], cwd: dir, env: {} }],
			() => {},
			fast
		);
		expect(code).toBe(1);
	});
});
