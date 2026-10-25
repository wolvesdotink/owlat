import { describe, it, expect, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `exec` against real child processes. Every other suite scripts Docker
 * through a fake `spawn`; what is pinned here is what a fake cannot show:
 * that a slow command leaves the event loop free, and that a command which is
 * stopped (timeout, shutdown, deadline) is stopped with everything it started
 * and collected before `exec` returns.
 */

const DIR = mkdtempSync(join(tmpdir(), 'owlat-updater-exec-'));
process.env['OWLAT_DIR'] = DIR;

const { exec, stopRunningChildren } = await import('../http.js');

/** Whether `pid` is still a live process. */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Whether `pid` has stopped running: gone, or a zombie its new parent has not
 * collected yet (an orphan is collected by init, not by us).
 */
function stoppedRunning(pid: number): boolean {
	if (!alive(pid)) return true;
	try {
		return execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf-8' })
			.trim()
			.startsWith('Z');
	} catch {
		// `ps` exits non-zero when no such process is left.
		return true;
	}
}

/** A command that starts a background `sleep` and prints its pid first. */
function spawnsGrandchild(pidFile: string): string {
	return `sleep 30 & echo $! > ${pidFile}; wait`;
}

/**
 * A command whose leader exits on SIGTERM while a descendant in its process
 * group ignores it: the shape of a `docker` CLI that goes on the signal while
 * the compose plugin it started carries on. `holdsPipes` picks whether the
 * descendant keeps the command's output pipes open (so `close` waits for it)
 * or lets go of them (so `close` fires the moment the leader exits).
 */
function leaderWithStubbornDescendant(pidFile: string, holdsPipes: boolean): string {
	const redirect = holdsPipes ? '' : ' >/dev/null 2>&1';
	// The descendant writes its pid only once it ignores SIGTERM, so a test
	// never signals it before the trap is in place.
	const descendant = `trap "" TERM; echo $$ > ${pidFile}; exec sleep 30`;
	return `sh -c '${descendant}'${redirect} & wait`;
}

/** Descendants a test started; killed after each test whatever it asserted. */
const strays: number[] = [];

/** A named pipe a test command writes its descendant's pid to. */
function pidPipe(name: string): string {
	const path = join(DIR, name);
	execFileSync('mkfifo', [path]);
	return path;
}

/**
 * The pid a test command writes to `pipe` once its descendant is ready, and
 * track it. Reading the pipe waits for the writer to open, write and close it.
 */
async function descendantPid(pipe: string): Promise<number> {
	const pid = Number((await readFile(pipe, 'utf-8')).trim());
	if (!Number.isInteger(pid) || pid <= 0) throw new Error(`no pid in ${pipe}`);
	strays.push(pid);
	return pid;
}

afterEach(async () => {
	for (const pid of strays.splice(0)) {
		try {
			process.kill(pid, 'SIGKILL');
		} catch {
			// Gone already, which is what the test wanted.
		}
	}
	await stopRunningChildren(100);
});

describe('exec', () => {
	it('reports success by exit status, with the output the child wrote', async () => {
		const result = await exec('sh', ['-c', 'echo out; echo progress >&2'], DIR);
		expect(result).toEqual({ ok: true, stdout: 'out\n', stderr: 'progress\n' });
	});

	it('fails a non-zero exit, and says so when the child said nothing', async () => {
		expect(await exec('sh', ['-c', 'echo denied >&2; exit 3'], DIR)).toEqual({
			ok: false,
			stdout: '',
			stderr: 'denied\n',
		});
		expect(await exec('sh', ['-c', 'exit 3'], DIR)).toMatchObject({
			ok: false,
			stderr: 'sh exited with code 3',
		});
	});

	it('fails a command that cannot be started, rather than throwing', async () => {
		const result = await exec('owlat-no-such-command', [], DIR);
		expect(result.ok).toBe(false);
		expect(result.stderr).toContain('ENOENT');
	});

	it('passes arguments as an argv, never through a shell', async () => {
		const result = await exec('printf', ['%s|', 'a b', '$(id)', ';rm -rf /'], DIR);
		expect(result.stdout).toBe('a b|$(id)|;rm -rf /|');
	});

	/**
	 * The defect this module was rewritten for: execFileSync held the event loop
	 * for the whole command, so /health, a 409 and the SIGTERM handler all
	 * waited for a five-minute pull.
	 */
	it('leaves the event loop free while a slow command runs', async () => {
		const ticks: number[] = [];
		const timer = setInterval(() => ticks.push(Date.now()), 10);
		const result = await exec('sleep', ['0.3'], DIR);
		clearInterval(timer);

		expect(result.ok).toBe(true);
		expect(ticks.length).toBeGreaterThan(5);
	});

	it('keeps the tail of a stream that runs past the bound, without killing the child', async () => {
		const result = await exec(
			'sh',
			['-c', 'head -c 5000000 /dev/zero | tr "\\0" a; echo END; echo done >&2'],
			DIR
		);

		expect(result.ok).toBe(true);
		expect(result.stdout.length).toBeLessThan(2.1 * 1024 * 1024);
		expect(result.stdout).toMatch(/^\[\d+ earlier bytes omitted\]\n/);
		expect(result.stdout.endsWith('aaaEND\n')).toBe(true);
		expect(result.stderr).toBe('done\n');
	});

	it('stops a command at its timeout, grandchildren included, and collects it', async () => {
		const pidFile = join(DIR, 'timeout.pid');
		// The grandchild sleeps 30 s and holds the output pipes: only the timeout
		// stopping the group lets `exec` return, and it returns once the group
		// has gone.
		const result = await exec('sh', ['-c', spawnsGrandchild(pidFile)], DIR, {
			timeoutMs: 200,
		});

		expect(result.ok).toBe(false);
		expect(result.stderr).toContain('sh timed out after 0.2s');
		expect(stoppedRunning(Number(readFileSync(pidFile, 'utf-8')))).toBe(true);
	});

	it('kills a command that ignores SIGTERM once the grace runs out', async () => {
		const result = await exec('sh', ['-c', 'trap "" TERM; while :; do sleep 0.05; done'], DIR, {
			timeoutMs: 100,
			killGraceMs: 200,
		});

		expect(result.ok).toBe(false);
		expect(result.stderr).toContain('timed out');
	});

	it('stops a command when its signal aborts, and does not start one after', async () => {
		const pidFile = join(DIR, 'abort.pid');
		const controller = new AbortController();
		const running = exec('sh', ['-c', spawnsGrandchild(pidFile)], DIR, {
			signal: controller.signal,
		});
		await new Promise((resolve) => setTimeout(resolve, 150));
		controller.abort();

		const result = await running;
		expect(result.ok).toBe(false);
		expect(result.stderr).toContain('was stopped because the updater is shutting down');
		expect(stoppedRunning(Number(readFileSync(pidFile, 'utf-8')))).toBe(true);

		const late = await exec('sh', ['-c', 'echo never'], DIR, { signal: controller.signal });
		expect(late).toEqual({
			ok: false,
			stdout: '',
			stderr: 'sh was not started: the updater is shutting down',
		});
	});

	/**
	 * The leader going on SIGTERM is not the group going: a descendant that
	 * ignores it is still running, and still gets the SIGKILL.
	 */
	it.each([
		['holds the output pipes', true],
		['has let go of the output pipes', false],
	])(
		'kills a SIGTERM-resistant descendant after its leader exits, when it %s',
		async (_, holdsPipes) => {
			const pidFile = pidPipe(`stubborn-abort-${holdsPipes}.pid`);
			const controller = new AbortController();
			const running = exec('sh', ['-c', leaderWithStubbornDescendant(pidFile, holdsPipes)], DIR, {
				signal: controller.signal,
				killGraceMs: 300,
			});
			const pid = await descendantPid(pidFile);
			controller.abort();

			const result = await running;
			expect(result.ok).toBe(false);
			expect(result.stderr).toContain('was stopped because the updater is shutting down');
			expect(alive(pid)).toBe(false);
		}
	);
});

describe('stopRunningChildren', () => {
	// What gets stopped is asserted here, against real process groups. How long
	// a stop takes is pinned with fake timers in stopRunningChildren.test.ts,
	// since a busy CI runner's clock says little (#1315). A stop that hung
	// would run into this generous per-test timeout instead.
	const STOP_TEST_TIMEOUT_MS = 15_000;

	/** What the shutdown deadline does before the process exits. */
	it(
		'stops and collects every command still running',
		{ timeout: STOP_TEST_TIMEOUT_MS },
		async () => {
			const pidFile = join(DIR, 'deadline.pid');
			const running = exec('sh', ['-c', spawnsGrandchild(pidFile)], DIR);
			await new Promise((resolve) => setTimeout(resolve, 150));

			await stopRunningChildren(1_000);

			const result = await running;
			expect(result.ok).toBe(false);
			expect(stoppedRunning(Number(readFileSync(pidFile, 'utf-8')))).toBe(true);
		}
	);

	it.each([
		['holds the output pipes', true],
		['has let go of the output pipes', false],
	])(
		'kills a SIGTERM-resistant descendant whose leader has exited, when it %s',
		{ timeout: STOP_TEST_TIMEOUT_MS },
		async (_, holdsPipes) => {
			const pidFile = pidPipe(`stubborn-deadline-${holdsPipes}.pid`);
			const running = exec('sh', ['-c', leaderWithStubbornDescendant(pidFile, holdsPipes)], DIR);
			const pid = await descendantPid(pidFile);

			await stopRunningChildren(300);

			expect(alive(pid)).toBe(false);
			expect((await running).ok).toBe(false);
		}
	);

	it('returns at once when nothing is running', async () => {
		// Fake timers: had it armed its 5 s grace timer it would never settle
		// here. That is checked without reading the clock (#1315).
		vi.useFakeTimers();
		try {
			let settled = false;
			const stopping = stopRunningChildren(5_000).then(() => {
				settled = true;
			});
			// Let pending promise callbacks run while the fake clock stands still.
			await vi.advanceTimersByTimeAsync(0);
			expect(settled).toBe(true);
			expect(vi.getTimerCount()).toBe(0);
			await stopping;
		} finally {
			vi.useRealTimers();
		}
	});
});
