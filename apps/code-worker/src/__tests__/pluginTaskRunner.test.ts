import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';
import { getFunctionName } from 'convex/server';
import {
	PLUGIN_WORKER_JOB_KIND_LOCAL_ID_CASES,
	PLUGIN_WORKER_RESULT_MAX_BYTES,
	pluginWorkerClaimedJobOf,
	pluginWorkerJobLocalIdOf,
} from '@owlat/plugin-kit';
import { describe, it, expect, vi } from 'vitest';
import {
	BUILTIN_JOB_COMMANDS,
	buildJobEnv,
	pollForPluginTask,
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
	taskId: 'job-1',
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

	// The worker parses a job kind with the SAME @owlat/plugin-kit authority the
	// host enqueue path uses; this shared conformance table (imported from
	// plugin-kit) makes a grammar drift between the two impossible to miss.
	it.each(PLUGIN_WORKER_JOB_KIND_LOCAL_ID_CASES)(
		'parses $kind → $localId via the shared plugin-kit grammar',
		({ kind, localId }) => {
			expect(pluginWorkerJobLocalIdOf(kind)).toBe(localId);
		}
	);
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

	it('byte-clamps a multibyte result to the host result ceiling (no ~4x overshoot)', async () => {
		// A hostile/verbose job emits far more than the byte budget in 4-byte code
		// points. Clamping by CHARACTER count would let ~4x the byte budget through;
		// the worker must clamp by BYTES and never split a code point.
		const child = openChild();
		const spawnSpy = vi.fn(() => {
			setImmediate(() => {
				child.stdout.emit('data', Buffer.from('😀'.repeat(20_000))); // 80000 bytes
				child.emit('close', 0);
			});
			return child;
		}) as unknown as typeof spawn;
		const client = fakeClient();

		await runPluginJob(task, {
			client: client as never,
			spawnFn: spawnSpy,
			prepareDir: () => {},
			cleanupDir: () => {},
			heartbeatIntervalMs: 10_000,
		});

		const completeCall = client.calls.find((c) => c.name === 'complete');
		const result = (completeCall?.args as { result: string }).result;
		expect(Buffer.byteLength(result)).toBeLessThanOrEqual(PLUGIN_WORKER_RESULT_MAX_BYTES);
		// Every retained code point is a whole '😀' — no truncated surrogate half.
		expect([...result].every((codePoint) => codePoint === '😀')).toBe(true);
		expect(result.length).toBeGreaterThan(0);
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

	it('slices a failing job’s error snippet by whole code points (never a split surrogate)', async () => {
		// A non-zero exit reports the TAIL of stdout/stderr. If that tail is sliced by
		// UTF-16 code unit, the 500-unit boundary can fall mid-surrogate and emit a
		// lone surrogate half; the worker must slice by whole code points instead.
		const child = openChild();
		const spawnSpy = vi.fn(() => {
			setImmediate(() => {
				// 600 four-byte code points then a 1-unit char: a naive slice(-500)
				// would start inside a surrogate pair (odd offset from the end).
				child.stdout.emit('data', Buffer.from(`${'😀'.repeat(600)}x`));
				child.emit('close', 1); // non-zero exit -> fail path
			});
			return child;
		}) as unknown as typeof spawn;
		const client = fakeClient();

		await runPluginJob(task, {
			client: client as never,
			spawnFn: spawnSpy,
			prepareDir: () => {},
			cleanupDir: () => {},
			heartbeatIntervalMs: 10_000,
		});

		const failCall = client.calls.find((c) => c.name === 'fail');
		const message = (failCall?.args as { errorMessage: string }).errorMessage;
		const codePoints = [...message];
		expect(codePoints).toHaveLength(500); // clamped to the code-point cap
		// No retained unit is a lone surrogate (a split '😀' half would be).
		expect(
			codePoints.every((cp) => {
				const code = cp.codePointAt(0) ?? 0;
				return code < 0xd800 || code > 0xdfff;
			})
		).toBe(true);
		expect(message.endsWith('x')).toBe(true); // kept the tail
	});
});

/**
 * A faithful in-memory stand-in for the Convex host queue. It projects each
 * persisted row through the REAL shared `pluginWorkerClaimedJobOf` — the exact
 * projection `plugins/workerTasks` uses over the wire — and keys every follow-up
 * mutation on the echoed `taskId`, mirroring the host's `v.id('pluginTasks')`
 * validator (a missing id is rejected, not silently accepted). This is the
 * host->worker WIRE boundary: if the two sides ever drift on the claimed-job
 * field name again, `next.taskId` arrives `undefined`, the id never threads
 * through claim/complete, and the seeded job never reaches a terminal state — so
 * the drift fails THIS test closed instead of hiding behind two green same-side
 * suites (the failure the reviewer's F1/F2 called out).
 */
interface HostRow {
	_id: string;
	pluginId: string;
	jobKind: string;
	payload: string;
	timeoutMs: number;
	attempts: number;
	maxAttempts: number;
	status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
	createdAt: number;
	result?: string;
	errorMessage?: string;
}

function hostQueueStub(seed: HostRow[]) {
	const rows = new Map<string, HostRow>(seed.map((row) => [row._id, { ...row }]));
	// Mirror the host's v.id('pluginTasks') arg validator: a missing/undefined id
	// is rejected outright — exactly the throw the drift produced in production.
	const requireId = (taskId: unknown): string => {
		if (typeof taskId !== 'string') {
			throw new Error(`ArgumentValidationError: taskId is not an Id (${String(taskId)})`);
		}
		return taskId;
	};
	const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
		getNextQueued: () => {
			const queued = [...rows.values()]
				.filter((r) => r.status === 'queued')
				.sort((a, b) => a.createdAt - b.createdAt)[0];
			return queued ? pluginWorkerClaimedJobOf(queued) : null;
		},
		claim: (args) => {
			const row = rows.get(requireId(args['taskId']));
			if (!row || row.status !== 'queued') return { claimed: false };
			row.status = 'running';
			row.attempts += 1;
			return { claimed: true, job: pluginWorkerClaimedJobOf(row) };
		},
		heartbeat: (args) => {
			const row = rows.get(requireId(args['taskId']));
			return { alive: row?.status === 'running', cancelRequested: false };
		},
		complete: (args) => {
			const row = rows.get(requireId(args['taskId']));
			if (!row || row.status !== 'running') return { ok: false };
			row.status = 'succeeded';
			row.result = args['result'] as string | undefined;
			return { ok: true };
		},
		fail: (args) => {
			const row = rows.get(requireId(args['taskId']));
			if (!row || row.status !== 'running') return { status: 'failed', retried: false };
			row.status = 'failed';
			row.errorMessage = args['errorMessage'] as string;
			return { status: 'failed', retried: false };
		},
	};
	const dispatch = (reference: unknown, args: unknown) => {
		const name =
			getFunctionName(reference as never)
				.split(':')
				.pop() ?? '';
		return handlers[name]!((args ?? {}) as Record<string, unknown>);
	};
	return {
		rows,
		query: vi.fn(async (reference: unknown, args: unknown) => dispatch(reference, args)),
		mutation: vi.fn(async (reference: unknown, args: unknown) => dispatch(reference, args)),
	};
}

describe('pollForPluginTask — the real host->worker wire boundary', () => {
	function seededRow(overrides: Partial<HostRow> = {}): HostRow {
		return {
			_id: 'row-1',
			pluginId: 'lab',
			jobKind: 'plugin.lab.selftest',
			payload: '{}',
			timeoutMs: 50,
			attempts: 0,
			maxAttempts: 3,
			status: 'queued',
			createdAt: 1,
			...overrides,
		};
	}

	it('claims and runs a seeded queued job through to a terminal succeeded state', async () => {
		const host = hostQueueStub([seededRow()]);
		const spawnSpy = vi.fn(() => closingChild(0)) as unknown as typeof spawn;

		await pollForPluginTask({
			client: host as never,
			spawnFn: spawnSpy,
			prepareDir: () => {},
			cleanupDir: () => {},
			heartbeatIntervalMs: 10_000,
		});

		// The job actually ran (poll -> claim -> spawn) and completed. This only holds
		// if `pollForPluginTask` read the host's `taskId` off `getNextQueued`/`claim`
		// and echoed it back on `complete`; a field-name drift makes the id undefined,
		// claim never matches the row, nothing spawns, and the row stays `queued`.
		expect(spawnSpy).toHaveBeenCalledTimes(1);
		expect(host.rows.get('row-1')!.status).toBe('succeeded');
	});

	it('is a no-op on an empty queue (never claims or spawns)', async () => {
		const host = hostQueueStub([]);
		const spawnSpy = vi.fn(() => closingChild(0)) as unknown as typeof spawn;

		await pollForPluginTask({
			client: host as never,
			spawnFn: spawnSpy,
			prepareDir: () => {},
			cleanupDir: () => {},
		});

		expect(host.query).toHaveBeenCalledTimes(1);
		expect(host.mutation).not.toHaveBeenCalled();
		expect(spawnSpy).not.toHaveBeenCalled();
	});
});
