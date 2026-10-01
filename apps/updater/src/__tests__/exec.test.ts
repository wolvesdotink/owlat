import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
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

/** Poll until `pid` is gone (an orphan is collected by init, not by us). */
async function gone(pid: number, withinMs = 3_000): Promise<boolean> {
	const until = Date.now() + withinMs;
	while (Date.now() < until) {
		if (!alive(pid)) return true;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return !alive(pid);
}

/** A command that starts a background `sleep` and prints its pid first. */
function spawnsGrandchild(pidFile: string): string {
	return `sleep 30 & echo $! > ${pidFile}; wait`;
}

afterEach(async () => {
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
		const started = Date.now();
		const result = await exec('sh', ['-c', spawnsGrandchild(pidFile)], DIR, {
			timeoutMs: 200,
		});

		expect(Date.now() - started).toBeLessThan(3_000);
		expect(result.ok).toBe(false);
		expect(result.stderr).toContain('sh timed out after 0.2s');
		expect(await gone(Number(readFileSync(pidFile, 'utf-8')))).toBe(true);
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
		expect(await gone(Number(readFileSync(pidFile, 'utf-8')))).toBe(true);

		const late = await exec('sh', ['-c', 'echo never'], DIR, { signal: controller.signal });
		expect(late).toEqual({
			ok: false,
			stdout: '',
			stderr: 'sh was not started: the updater is shutting down',
		});
	});
});

describe('stopRunningChildren', () => {
	/** What the shutdown deadline does before the process exits. */
	it('stops and collects every command still running', async () => {
		const pidFile = join(DIR, 'deadline.pid');
		const running = exec('sh', ['-c', spawnsGrandchild(pidFile)], DIR);
		await new Promise((resolve) => setTimeout(resolve, 150));

		const started = Date.now();
		await stopRunningChildren(1_000);

		expect(Date.now() - started).toBeLessThan(2_000);
		const result = await running;
		expect(result.ok).toBe(false);
		expect(await gone(Number(readFileSync(pidFile, 'utf-8')))).toBe(true);
	});

	it('returns at once when nothing is running', async () => {
		const started = Date.now();
		await stopRunningChildren(5_000);
		expect(Date.now() - started).toBeLessThan(100);
	});
});
