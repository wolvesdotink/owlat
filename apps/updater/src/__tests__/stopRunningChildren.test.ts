import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * How long `stopRunningChildren` takes, on a scripted child and fake timers, so
 * the bounds are read off the clock the code runs on rather than a busy CI
 * runner's (#1315). `exec.test.ts` pins the same calls against real process
 * groups, where only what gets stopped is asserted.
 *
 * The child has no pid, so `exec` signals it through `kill`, and its "group"
 * is gone once it has ended.
 */

const state = vi.hoisted(() => ({
	/** The signals that end the next child; any other is ignored. */
	endsOn: new Set<string>(),
	/** Every signal sent, in order. */
	sent: [] as string[],
	/** End the last child as if `signal` had killed it. */
	end: (_signal: string) => {},
}));

vi.mock('node:child_process', async () => {
	const { EventEmitter } = await import('node:events');
	return {
		spawn: () => {
			const child = Object.assign(new EventEmitter(), {
				pid: undefined,
				exitCode: null as number | null,
				signalCode: null as string | null,
				stdout: new EventEmitter(),
				stderr: new EventEmitter(),
				kill: (signal = 'SIGTERM') => {
					state.sent.push(signal);
					if (state.endsOn.has(signal)) end(signal);
					return true;
				},
			});
			const end = (signal: string) => {
				if (child.signalCode !== null) return;
				child.signalCode = signal;
				child.emit('exit', null, signal);
				child.emit('close', null, signal);
			};
			state.end = end;
			return child;
		},
	};
});

process.env['OWLAT_DIR'] = mkdtempSync(join(tmpdir(), 'owlat-updater-stop-'));
const { exec, stopRunningChildren } = await import('../http.js');

/** `GROUP_COLLECT_MS` in http.ts: how long a group gets after SIGKILL. */
const COLLECT_MS = 1_000;

afterEach(() => {
	vi.useRealTimers();
	state.endsOn = new Set();
	state.sent = [];
});

/** Start one long command, then `stopRunningChildren(graceMs)`; report when it settles. */
function stopOne(graceMs: number) {
	const run = exec('docker', ['compose', 'pull'], '/');
	const stop = { settled: false };
	const stopping = stopRunningChildren(graceMs).then(() => {
		stop.settled = true;
	});
	return { run, stop, stopping };
}

describe('stopRunningChildren timing', () => {
	it('returns as soon as a group ends on SIGTERM, without waiting out the grace', async () => {
		vi.useFakeTimers();
		state.endsOn = new Set(['SIGTERM']);
		const { run, stop, stopping } = stopOne(5_000);

		await vi.advanceTimersByTimeAsync(0);
		expect(stop.settled).toBe(true);
		expect(state.sent).toEqual(['SIGTERM']);
		await stopping;
		expect((await run).ok).toBe(false);
	});

	it('sends SIGKILL when the grace runs out, and returns once the group is gone', async () => {
		vi.useFakeTimers();
		state.endsOn = new Set(['SIGKILL']);
		const { run, stop, stopping } = stopOne(300);

		await vi.advanceTimersByTimeAsync(299);
		expect(state.sent).toEqual(['SIGTERM']);
		expect(stop.settled).toBe(false);

		await vi.advanceTimersByTimeAsync(1);
		expect(state.sent).toEqual(['SIGTERM', 'SIGKILL']);
		expect(stop.settled).toBe(true);
		await stopping;
		expect((await run).ok).toBe(false);
	});

	it('gives up on a group that outlives SIGKILL once the collect bound runs out', async () => {
		vi.useFakeTimers();
		const { run, stop, stopping } = stopOne(300);

		await vi.advanceTimersByTimeAsync(300 + COLLECT_MS - 1);
		expect(state.sent).toEqual(['SIGTERM', 'SIGKILL']);
		expect(stop.settled).toBe(false);

		await vi.advanceTimersByTimeAsync(1);
		expect(stop.settled).toBe(true);
		await stopping;

		// The child is still in `running` until it ends; end it for the next test.
		state.end('SIGKILL');
		expect((await run).ok).toBe(false);
	});
});
