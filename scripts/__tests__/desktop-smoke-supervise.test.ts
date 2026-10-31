/**
 * How the desktop smoke harness owns a launched app
 * (scripts/desktop-smoke/supervise.ts), driven by a fake child process and
 * fake timers: the run lasts until the output closes, not until the first
 * process exits, and a run that does not finish is stopped at its deadline.
 */

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	runApp,
	type LaunchSpec,
	type RunResult,
	type SuperviseDeps,
} from '../desktop-smoke/supervise';

class FakeChild extends EventEmitter {
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	constructor(readonly pid: number | undefined) {
		super();
	}
	/** The launched process exits; whatever it started may still hold the pipes. */
	exit(code: number | null, signal: NodeJS.Signals | null = null) {
		this.emit('exit', code, signal);
	}
	/** Every holder of the pipes is gone: node emits 'close' once both have ended. */
	close() {
		let open = 2;
		const ended = () => {
			open -= 1;
			if (open === 0) this.emit('close');
		};
		this.stdout.once('end', ended);
		this.stderr.once('end', ended);
		this.stdout.end();
		this.stderr.end();
	}
}

const spec: LaunchSpec = {
	command: '/apps/Owlat.AppImage',
	args: [],
	env: { HOME: '/profile' },
	deadlineMs: 60_000,
	graceMs: 5_000,
};

function harness(pid: number | null = 4242) {
	const child = new FakeChild(pid ?? undefined);
	const signals: [number, NodeJS.Signals][] = [];
	const spawn = vi.fn(() => child as unknown as ChildProcess);
	const deps: SuperviseDeps = {
		spawn,
		signalGroup: (pgid, signal) => {
			signals.push([pgid, signal]);
			return true;
		},
		echo: () => {},
	};
	return { child, signals, spawn, deps };
}

/** Let stream events and promise callbacks run; only timeouts are faked. */
async function settle() {
	for (let i = 0; i < 3; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
	vi.useRealTimers();
});

describe('runApp', () => {
	it('starts the app in its own process group with the given environment', async () => {
		const { child, spawn, deps } = harness();
		const run = runApp(spec, deps);
		child.close();
		await settle();
		await run;
		expect(spawn).toHaveBeenCalledWith('/apps/Owlat.AppImage', [], {
			cwd: undefined,
			env: { HOME: '/profile' },
			detached: true,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
	});

	it('reads reports and fatal lines from both streams, split across chunks', async () => {
		const { child, deps } = harness();
		const run = runApp(spec, deps);
		child.stdout.write('starting\nowlat-e2e {"event":"boot","pid":7,"vers');
		child.stdout.write('ion":"0.6.16"}\n');
		child.stderr.write("thread 'main' panicked at src/main.rs:1:1:\n");
		child.stdout.write('owlat-e2e {"event":"done","pid":7}');
		child.exit(0);
		child.close();
		await settle();
		const result = await run;
		expect(result.lines).toContain('starting');
		expect(result.reports).toEqual([
			{ event: 'boot', pid: 7, version: '0.6.16' },
			{ event: 'done', pid: 7 },
		]);
		expect(result.fatal).toEqual(["Rust panic: thread 'main' panicked at src/main.rs:1:1:"]);
		expect(result.exit).toEqual({ code: 0, signal: null });
		expect(result.stoppedAtDeadline).toBe(false);
	});

	it('keeps reading after the launched process exits, until the output closes', async () => {
		const { child, signals, deps } = harness();
		let result: RunResult | undefined;
		const run = runApp(spec, deps).then((r) => (result = r));
		child.stdout.write('owlat-e2e {"event":"restarting","pid":7}\n');
		child.exit(0);
		await settle();
		expect(result).toBeUndefined();
		// The relaunched process inherited the pipes.
		child.stdout.write('owlat-e2e {"event":"boot","pid":8,"version":"0.6.17"}\n');
		child.close();
		await settle();
		await run;
		expect(result!.reports.map((r) => r.pid)).toEqual([7, 8]);
		// Whatever let go of the pipes but kept running is stopped with the group.
		expect(signals).toEqual([[4242, 'SIGKILL']]);
	});

	it('stops the group at the deadline: SIGTERM, then SIGKILL after the grace period', async () => {
		const { child, signals, deps } = harness();
		const run = runApp(spec, deps);
		await vi.advanceTimersByTimeAsync(59_999);
		expect(signals).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		expect(signals).toEqual([[4242, 'SIGTERM']]);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(signals).toEqual([
			[4242, 'SIGTERM'],
			[4242, 'SIGKILL'],
		]);
		child.exit(null, 'SIGKILL');
		child.close();
		await settle();
		const result = await run;
		expect(result.stoppedAtDeadline).toBe(true);
		expect(result.aliveAtDeadline).toBe(true);
	});

	it('does not escalate when the group finishes inside the grace period', async () => {
		const { child, signals, deps } = harness();
		const run = runApp(spec, deps);
		await vi.advanceTimersByTimeAsync(60_000);
		child.exit(null, 'SIGTERM');
		child.close();
		await settle();
		await run;
		await vi.advanceTimersByTimeAsync(10_000);
		expect(signals).toEqual([
			[4242, 'SIGTERM'],
			[4242, 'SIGKILL'],
		]);
	});

	it('tells an app that exited early from one still running at the deadline', async () => {
		const { child, deps } = harness();
		const run = runApp(spec, deps);
		child.exit(1);
		// Something it started still holds the pipes.
		await vi.advanceTimersByTimeAsync(60_000);
		child.close();
		await settle();
		const result = await run;
		expect(result.stoppedAtDeadline).toBe(true);
		expect(result.aliveAtDeadline).toBe(false);
		expect(result.exit).toEqual({ code: 1, signal: null });
	});

	it('reports a launch that never started without signalling anything', async () => {
		const { child, signals, deps } = harness(null);
		const run = runApp(spec, deps);
		child.emit('error', new Error('spawn EACCES'));
		const result = await run;
		expect(result.spawnError).toBe('spawn EACCES');
		expect(result.exit).toBeNull();
		await vi.advanceTimersByTimeAsync(120_000);
		expect(signals).toEqual([]);
	});
});
