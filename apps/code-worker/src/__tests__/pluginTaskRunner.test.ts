import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';
import { getFunctionName } from 'convex/server';
import { describe, it, expect, vi } from 'vitest';
import {
	BUILTIN_JOB_COMMANDS,
	buildJobEnv,
	jobLocalId,
	resolveJobCommand,
	runPluginJob,
} from '../pluginTaskRunner.js';
import { SANDBOX_UID, SANDBOX_GID } from '../sandbox.js';
import type { PluginTask } from '../convexClient.js';

/**
 * HOSTILE-JOB ISOLATION for the Tier-3 plugin worker.
 *
 * CI cannot runtime-verify a kernel uid boundary, so — like uidSandbox.test —
 * these pin the WIRING that makes a hostile plugin job fail closed: it runs as a
 * separate uid, with NO ambient credentials, inside a killed-on-timeout /
 * killed-on-cancel process group, and an unknown job kind never spawns anything.
 */

/** A fake child that stays open until its `close` is emitted (for cancel/timeout). */
function openChild(pid = 4321) {
	const child = new EventEmitter() as EventEmitter & {
		stdout: EventEmitter;
		stderr: EventEmitter;
		pid: number;
	};
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.pid = pid;
	return child;
}

/** A fake child that closes immediately with the given exit code. */
function closingChild(code = 0) {
	const child = openChild();
	setImmediate(() => child.emit('close', code));
	return child;
}

function fakeClient(overrides: Partial<Record<string, unknown>> = {}) {
	const calls: Array<{ name: string; args: unknown }> = [];
	const record = (name: string) => (args: unknown) => {
		calls.push({ name, args });
		return (overrides[name] as ((a: unknown) => unknown) | undefined)?.(args) ?? { ok: true };
	};
	return {
		calls,
		query: vi.fn(record('getNextQueued')),
		mutation: vi.fn(async (reference: unknown, args: unknown) => {
			// e.g. 'plugins/workerTasks:heartbeat' → 'heartbeat'
			const name =
				getFunctionName(reference as never)
					.split(':')
					.pop() ?? 'other';
			return record(name)(args);
		}),
	};
}

const task: PluginTask = {
	_id: 'job-1',
	pluginId: 'lab',
	jobKind: 'plugin.lab.selftest',
	payload: '{}',
	timeoutMs: 50,
	attempts: 1,
	maxAttempts: 3,
};

describe('resolveJobCommand — only host-registered, well-formed kinds run', () => {
	it('resolves a registered built-in job kind to a host command', () => {
		const spec = resolveJobCommand('plugin.lab.selftest', '{}');
		expect(spec).toEqual(BUILTIN_JOB_COMMANDS['selftest']!('{}'));
	});

	it('returns null for an unregistered local id (fails closed, no command)', () => {
		expect(resolveJobCommand('plugin.lab.exfiltrate', '{}')).toBeNull();
	});

	it.each([
		'selftest', // not namespaced
		'plugin.lab.', // empty local id
		'plugin.lab.Bad', // invalid local id
		'plugin..selftest', // empty plugin id
		'plugin.lab.a.b', // extra segment
	])('returns null for malformed kind %s', (kind) => {
		expect(resolveJobCommand(kind, '{}')).toBeNull();
	});

	it('extracts the local id only from a well-formed kind', () => {
		expect(jobLocalId('plugin.deliverability-lab.spam-score')).toBe('spam-score');
		expect(jobLocalId('nope')).toBeNull();
	});
});

describe('buildJobEnv — a sandboxed job gets NO ambient credentials', () => {
	it('passes through only PATH + a writable HOME + CI, dropping every secret', () => {
		const parent = {
			PATH: '/usr/bin',
			CONVEX_ADMIN_KEY: 'admin-secret',
			GITHUB_TOKEN: 'gh-secret',
			LLM_API_KEY: 'llm-secret',
			LLM_BASE_URL: 'https://llm.example',
			CONVEX_URL: 'https://convex.example',
		} as NodeJS.ProcessEnv;
		const env = buildJobEnv('/workspace/plugin-job-1', parent);

		expect(env).toEqual({ PATH: '/usr/bin', HOME: '/workspace/plugin-job-1', CI: 'true' });
		for (const secret of ['admin-secret', 'gh-secret', 'llm-secret']) {
			expect(JSON.stringify(env)).not.toContain(secret);
		}
	});
});

describe('runPluginJob — sandbox wiring', () => {
	it('spawns the job as the sandbox uid/gid with a secret-free env', async () => {
		const spawnSpy = vi.fn(() => closingChild(0)) as unknown as typeof spawn;
		const client = fakeClient();
		await runPluginJob(task, {
			client: client as never,
			spawnFn: spawnSpy,
			prepareDir: () => {},
			cleanupDir: () => {},
			heartbeatIntervalMs: 10_000,
		});

		const [, , opts] = (spawnSpy as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
		expect(opts).toMatchObject({ uid: SANDBOX_UID, gid: SANDBOX_GID });
		expect((opts as { env: NodeJS.ProcessEnv }).env['CONVEX_ADMIN_KEY']).toBeUndefined();
		expect((opts as { env: NodeJS.ProcessEnv }).env['GITHUB_TOKEN']).toBeUndefined();
		// A clean exit reports completion, never failure.
		expect(client.calls.some((c) => c.name === 'complete')).toBe(true);
		expect(client.calls.some((c) => c.name === 'fail')).toBe(false);
	});

	it('fails an unknown job kind closed — nothing is ever spawned', async () => {
		const spawnSpy = vi.fn(() => closingChild(0)) as unknown as typeof spawn;
		const client = fakeClient();
		await runPluginJob(
			{ ...task, jobKind: 'plugin.lab.exfiltrate' },
			{ client: client as never, spawnFn: spawnSpy, prepareDir: () => {}, cleanupDir: () => {} }
		);
		expect(spawnSpy).not.toHaveBeenCalled();
		const failCall = client.calls.find((c) => c.name === 'fail');
		expect(failCall).toBeDefined();
	});

	it('reaps the whole process group and reports timeout when the budget is exceeded', async () => {
		vi.useFakeTimers();
		try {
			const child = openChild(777);
			const spawnSpy = vi.fn(() => child) as unknown as typeof spawn;
			const kill = vi.fn(() => child.emit('close', null)); // emulate SIGKILL closing it
			const client = fakeClient();

			const done = runPluginJob(
				{ ...task, timeoutMs: 50 },
				{
					client: client as never,
					spawnFn: spawnSpy,
					prepareDir: () => {},
					cleanupDir: () => {},
					heartbeatIntervalMs: 10_000,
					kill,
				}
			);
			await vi.advanceTimersByTimeAsync(60);
			await done;

			// Whole group reaped via the NEGATIVE pid, then reported as a timeout.
			expect(kill).toHaveBeenCalledWith(-777, 'SIGKILL');
			const failCall = client.calls.find((c) => c.name === 'fail');
			expect((failCall?.args as { reasonCode?: string }).reasonCode).toBe('worker_timeout');
		} finally {
			vi.useRealTimers();
		}
	});

	it('kills the group and reports failure when the operator cancels mid-run (cannot be escaped)', async () => {
		vi.useFakeTimers();
		try {
			const child = openChild(888);
			const spawnSpy = vi.fn(() => child) as unknown as typeof spawn;
			const kill = vi.fn(() => child.emit('close', null));
			// The heartbeat mutation reports a cancel request on the first beat.
			const client = fakeClient({ heartbeat: () => ({ alive: true, cancelRequested: true }) });

			const done = runPluginJob(task, {
				client: client as never,
				spawnFn: spawnSpy,
				prepareDir: () => {},
				cleanupDir: () => {},
				heartbeatIntervalMs: 10,
				kill,
			});
			await vi.advanceTimersByTimeAsync(15);
			await done;

			expect(kill).toHaveBeenCalledWith(-888, 'SIGKILL');
			// A cancelled job is reported as failed (the host records it cancelled and
			// never retries it); it is NEVER reported as completed.
			expect(client.calls.some((c) => c.name === 'fail')).toBe(true);
			expect(client.calls.some((c) => c.name === 'complete')).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it('always cleans up the job scratch dir, even on failure', async () => {
		const cleanupDir = vi.fn();
		const client = fakeClient();
		await runPluginJob(
			{ ...task, jobKind: 'plugin.lab.exfiltrate' },
			{
				client: client as never,
				spawnFn: (() => closingChild(0)) as never,
				prepareDir: () => {},
				cleanupDir,
			}
		);
		// Unknown kind returns before touching a dir, so cleanup is not required
		// there; a resolved job must always clean up:
		await runPluginJob(task, {
			client: client as never,
			spawnFn: (() => closingChild(1)) as never,
			prepareDir: () => {},
			cleanupDir,
			heartbeatIntervalMs: 10_000,
		});
		expect(cleanupDir).toHaveBeenCalled();
	});
});
