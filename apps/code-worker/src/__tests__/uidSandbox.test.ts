import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import type { spawn } from 'node:child_process';
import {
	runUntrusted,
	runGit,
	runCodingAgent,
	runTests,
	SANDBOX_UID,
	SANDBOX_GID,
} from '../taskRunner.js';

/**
 * UID-ISOLATION WIRING.
 *
 * The orchestrator holds CONVEX_ADMIN_KEY / GITHUB_TOKEN / LLM_API_KEY in its
 * env and runs as root; the UNTRUSTED children (the coding agent + `npx vitest`)
 * MUST be spawned dropped to a SEPARATE unprivileged uid so they sit behind a
 * cross-uid kernel boundary and cannot read /proc/<orchestrator>/environ or
 * ptrace it. CI cannot runtime-verify the kernel boundary, so these tests pin
 * the WIRING: untrusted spawns carry { uid: SANDBOX_UID, gid: SANDBOX_GID };
 * the trusted git path (which carries the token out-of-band) does NOT.
 */

/** A fake child that immediately closes with the given exit code. */
function fakeChild(code = 0) {
	const child = new EventEmitter() as EventEmitter & {
		stdout: EventEmitter;
		stderr: EventEmitter;
		pid: number;
	};
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.pid = 12345;
	setImmediate(() => child.emit('close', code));
	return child;
}

/** Build a vi.fn() spawn stub that records its options and returns a fake child. */
function fakeSpawn() {
	return vi.fn((_cmd: string, _args: string[], _opts: unknown) =>
		fakeChild(0)
	) as unknown as typeof spawn;
}

describe('untrusted children run as the sandbox uid/gid', () => {
	it('SANDBOX_UID / SANDBOX_GID default to the Dockerfile ids (10001)', () => {
		// These MUST match the `sandbox` account baked into apps/code-worker/Dockerfile.
		expect(SANDBOX_UID).toBe(10001);
		expect(SANDBOX_GID).toBe(10001);
	});

	it('runUntrusted always pins uid/gid on the spawn options', async () => {
		const spy = fakeSpawn();
		await runUntrusted(
			'opencode',
			['--message', 'x'],
			{ cwd: '/w', env: {}, timeoutMs: 1000 },
			spy
		);
		expect(spy).toHaveBeenCalledTimes(1);
		const opts = (spy as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![2];
		expect(opts).toMatchObject({ uid: SANDBOX_UID, gid: SANDBOX_GID });
	});

	it('runCodingAgent spawns the opencode agent as the sandbox uid/gid', async () => {
		const spy = fakeSpawn();
		await runCodingAgent('/workspace/task-1', 'do the thing', spy);
		const [cmd, , opts] = (spy as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
		expect(cmd).toBe('opencode');
		expect(opts).toMatchObject({ uid: SANDBOX_UID, gid: SANDBOX_GID });
	});

	it('runTests spawns `npx vitest` as the sandbox uid/gid', async () => {
		const spy = fakeSpawn();
		await runTests('/workspace/task-1', spy);
		const [cmd, args, opts] = (spy as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
		expect(cmd).toBe('npx');
		expect(args).toEqual(['vitest', 'run', '--reporter=verbose']);
		expect(opts).toMatchObject({ uid: SANDBOX_UID, gid: SANDBOX_GID });
	});
});

describe('trusted git ops stay root (never dropped to the sandbox uid)', () => {
	it('runGit never sets uid/gid on the exec options (git keeps the token as root)', () => {
		const execFn = vi.fn(() => Buffer.from(''));
		runGit(['-C', '/w', 'push', 'origin', 'feat'], { stdio: 'inherit' }, execFn as never);
		expect(execFn).toHaveBeenCalledTimes(1);
		const [cmd, , opts] = execFn.mock.calls[0]! as unknown as [
			string,
			string[],
			Record<string, unknown>,
		];
		expect(cmd).toBe('git');
		expect(opts).not.toHaveProperty('uid');
		expect(opts).not.toHaveProperty('gid');
	});
});
