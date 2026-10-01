import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { describe, it, expect, vi } from 'vitest';
import {
	SANDBOX_OUTPUT_LIMITS,
	SANDBOX_OUTPUT_TRUNCATED,
	combinedOutputTail,
	createOutputCapture,
	runUntrusted,
	type DetachedRunResult,
} from '../sandbox.js';
import { runCodingAgent, runTests } from '../taskRunner.js';

/**
 * OUTPUT BOUNDS for sandboxed children.
 *
 * Untrusted children (the coding agent, `npx vitest`, plugin jobs) can write
 * without limit for their whole time budget. These tests pin that the trusted
 * orchestrator only ever holds a fixed head and tail of each stream while the
 * child runs, that the dropped middle is visible, and that a noisy run still
 * settles and reaps exactly once.
 */

const CHUNK = 256 * 1024;
const BURST_CHUNKS = 20; // 5 MiB per stream
const BUDGET = SANDBOX_OUTPUT_LIMITS.headBytes + SANDBOX_OUTPUT_LIMITS.tailBytes;

type FakeChild = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; pid: number };

/** A fake child that stays open until the test emits `close`. */
function openChild(): FakeChild {
	const child = new EventEmitter() as FakeChild;
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.pid = 4242;
	return child;
}

/** Emit a 5 MiB burst on both streams: `start` first, `end` last, filler in between. */
function burst(child: FakeChild) {
	for (let i = 0; i < BURST_CHUNKS; i++) {
		const out = Buffer.alloc(CHUNK, 'o');
		const err = Buffer.alloc(CHUNK, 'e');
		if (i === 0) out.write('start-of-stdout');
		if (i === BURST_CHUNKS - 1) {
			out.write('end-of-stdout', CHUNK - 'end-of-stdout'.length);
			err.write('end-of-stderr', CHUNK - 'end-of-stderr'.length);
		}
		child.stdout.emit('data', out);
		child.stderr.emit('data', err);
	}
}

function spawnReturning(child: FakeChild) {
	return vi.fn(() => child) as unknown as typeof spawn;
}

describe('createOutputCapture', () => {
	it('never retains more than head + tail while a large stream is still arriving', () => {
		const capture = createOutputCapture();
		let peak = 0;
		for (let i = 0; i < BURST_CHUNKS; i++) {
			capture.push(Buffer.alloc(CHUNK, i % 2 ? 'a' : 'b'));
			peak = Math.max(peak, capture.retainedBytes);
		}
		expect(capture.totalBytes).toBe(CHUNK * BURST_CHUNKS);
		expect(peak).toBe(BUDGET);
		expect(capture.truncated).toBe(true);
	});

	it('stays bounded under a flood of one-byte chunks and keeps the newest bytes', () => {
		const limits = { headBytes: 8, tailBytes: 16 };
		const capture = createOutputCapture(limits);
		const all: string[] = [];
		for (let i = 0; i < 10_000; i++) {
			const c = String.fromCharCode(97 + (i % 26));
			all.push(c);
			capture.push(Buffer.from(c));
			expect(capture.retainedBytes).toBeLessThanOrEqual(24);
		}
		const text = capture.text();
		const full = all.join('');
		expect(text.startsWith(full.slice(0, 8))).toBe(true);
		expect(text.endsWith(full.slice(-16))).toBe(true);
		expect(text).toContain(`[${SANDBOX_OUTPUT_TRUNCATED}: ${10_000 - 24} bytes omitted]`);
	});

	it('wraps the tail correctly for chunks that straddle the ring end', () => {
		const capture = createOutputCapture({ headBytes: 0, tailBytes: 10 });
		for (const piece of ['0123456', '789ab', 'cdefghi', 'jk']) capture.push(Buffer.from(piece));
		expect(capture.text()).toBe(`[${SANDBOX_OUTPUT_TRUNCATED}: 11 bytes omitted]\nbcdefghijk`);
	});

	it('returns output under the budget unchanged, with no marker', () => {
		const capture = createOutputCapture({ headBytes: 4, tailBytes: 4 });
		for (const piece of ['ab', 'cdef', 'gh']) capture.push(Buffer.from(piece));
		expect(capture.truncated).toBe(false);
		expect(capture.text()).toBe('abcdefgh');
	});

	it('keeps a UTF-8 sequence that is split across chunks intact', () => {
		const capture = createOutputCapture();
		const bytes = Buffer.from('price: 5€ 😀 done');
		for (let i = 0; i < bytes.length; i++) capture.push(bytes.subarray(i, i + 1));
		expect(capture.text()).toBe('price: 5€ 😀 done');
	});

	it('drops partial characters at the cut instead of decoding them into replacement characters', () => {
		// 3-byte '€' never aligns with a 4-byte head or a 5-byte tail.
		const capture = createOutputCapture({ headBytes: 4, tailBytes: 5 });
		capture.push(Buffer.from('€'.repeat(20)));
		const text = capture.text();
		expect(text).not.toContain('�');
		expect(text).toBe(`€\n[${SANDBOX_OUTPUT_TRUNCATED}: 51 bytes omitted]\n€`);
	});
});

describe('combinedOutputTail', () => {
	const base: DetachedRunResult = {
		code: 1,
		stdout: '',
		stderr: '',
		timedOut: false,
		killed: false,
		outputTruncated: false,
	};

	it('returns the plain tail when nothing was dropped', () => {
		expect(combinedOutputTail({ ...base, stdout: ' abc', stderr: 'def\n' }, 4)).toBe('cdef');
	});

	it('flags dropped output within the requested length', () => {
		const out = combinedOutputTail(
			{ ...base, stdout: 'x'.repeat(5000), stderr: 'last', outputTruncated: true },
			200
		);
		expect(out.length).toBe(200);
		expect(out.startsWith(`[${SANDBOX_OUTPUT_TRUNCATED}`)).toBe(true);
		expect(out.endsWith('xlast')).toBe(true);
	});
});

describe('runUntrusted bounds a noisy child', () => {
	it.each(['success', 'timeout', 'cancel'] as const)(
		'keeps a bounded, marked result and reaps once on %s',
		async (mode) => {
			vi.useFakeTimers();
			try {
				const child = openChild();
				const controller = new AbortController();
				const reap = vi.fn(() => {
					// Emulate SIGKILL closing the pipes of a still-running child.
					if (mode !== 'success') child.emit('close', null);
				});
				const run = runUntrusted(
					'noisy',
					[],
					{ cwd: '/w', env: {}, timeoutMs: 1_000, signal: controller.signal, reap },
					spawnReturning(child)
				);
				burst(child);
				if (mode === 'success') {
					child.emit('exit', 0);
					child.emit('close', 0);
				} else if (mode === 'timeout') {
					await vi.advanceTimersByTimeAsync(1_000);
				} else {
					controller.abort();
				}
				const result = await run;

				expect(reap).toHaveBeenCalledTimes(1);
				expect(result.timedOut).toBe(mode === 'timeout');
				expect(result.killed).toBe(mode === 'cancel');
				expect(result.outputTruncated).toBe(true);
				const marker = `[${SANDBOX_OUTPUT_TRUNCATED}: ${CHUNK * BURST_CHUNKS - BUDGET} bytes omitted]`;
				for (const stream of [result.stdout, result.stderr]) {
					expect(Buffer.byteLength(stream)).toBeLessThanOrEqual(BUDGET + marker.length + 2);
					expect(stream).toContain(marker);
				}
				expect(result.stdout.startsWith('start-of-stdout')).toBe(true);
				expect(result.stdout.endsWith('end-of-stdout')).toBe(true);
				expect(result.stderr.endsWith('end-of-stderr')).toBe(true);
			} finally {
				vi.useRealTimers();
			}
		}
	);

	it('decodes a UTF-8 character split across two pipe chunks', async () => {
		const child = openChild();
		const run = runUntrusted(
			'agent',
			[],
			{ cwd: '/w', env: {}, timeoutMs: 1_000, reap: vi.fn() },
			spawnReturning(child)
		);
		const bytes = Buffer.from('ok 😀');
		child.stdout.emit('data', bytes.subarray(0, 5));
		child.stdout.emit('data', bytes.subarray(5));
		child.emit('close', 0);
		expect((await run).stdout).toBe('ok 😀');
	});
});

describe('task runners report a bounded, visibly truncated output', () => {
	it('runTests keeps at most 2000 characters and says the sandbox dropped output', async () => {
		const child = openChild();
		const run = runTests('/w', spawnReturning(child), vi.fn());
		burst(child);
		child.emit('close', 1);
		const { passed, output } = await run;
		expect(passed).toBe(false);
		expect(output.length).toBeLessThanOrEqual(2000);
		expect(output.startsWith(`[${SANDBOX_OUTPUT_TRUNCATED}`)).toBe(true);
		expect(output.endsWith('end-of-stderr')).toBe(true);
	});

	it('runTests keeps its timeout header and the truncation note within 2000 characters', async () => {
		vi.useFakeTimers();
		try {
			const child = openChild();
			const reap = vi.fn(() => {
				child.emit('close', null);
			});
			const run = runTests('/w', spawnReturning(child), reap);
			burst(child);
			await vi.advanceTimersByTimeAsync(300_000);
			const { output } = await run;
			expect(output.length).toBeLessThanOrEqual(2000);
			expect(output.startsWith('Tests timed out after 5m')).toBe(true);
			expect(output).toContain(SANDBOX_OUTPUT_TRUNCATED);
		} finally {
			vi.useRealTimers();
		}
	});

	it('runCodingAgent failure output leads with the truncation note', async () => {
		const child = openChild();
		const run = runCodingAgent('/w', 'task', spawnReturning(child), vi.fn());
		burst(child);
		child.emit('close', 2);
		const { success, output } = await run;
		expect(success).toBe(false);
		expect(output.length).toBeLessThanOrEqual(2000);
		expect(output.slice(0, 500)).toContain(SANDBOX_OUTPUT_TRUNCATED);
	});
});

/**
 * Real pipes. `runUntrusted` pins the sandbox uid, which an unprivileged test
 * process cannot switch to, so the spawn wrapper drops uid/gid and records the
 * process group; the injected reap kills that group, as production reaps the uid.
 */
describe('runUntrusted with real child processes', () => {
	function localSpawn() {
		const groups: number[] = [];
		const spawnFn = ((command: string, args: string[], options: Record<string, unknown>) => {
			const { uid: _uid, gid: _gid, ...rest } = options;
			const child = spawn(command, args, rest);
			if (child.pid) groups.push(child.pid);
			return child;
		}) as unknown as typeof spawn;
		const reap = vi.fn(() => {
			for (const pgid of groups.splice(0)) {
				try {
					process.kill(-pgid, 'SIGKILL');
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
				}
			}
		});
		return { spawnFn, reap };
	}

	const limits = { headBytes: 1024, tailBytes: 1024 };

	it('drains several MiB on both streams and returns only the bounded head and tail', async () => {
		const { spawnFn, reap } = localSpawn();
		const script = `
			const block = 'x'.repeat(64 * 1024);
			process.stdout.write('HEAD');
			for (let i = 0; i < 64; i++) { process.stdout.write(block); process.stderr.write(block); }
			process.stdout.write('€TAIL');
			process.stderr.write('ERR-TAIL');
		`;
		const result = await runUntrusted(
			process.execPath,
			['-e', script],
			{ cwd: '/', env: {}, timeoutMs: 20_000, reap, outputLimits: limits },
			spawnFn
		);
		expect(result.code).toBe(0);
		expect(result.outputTruncated).toBe(true);
		expect(reap).toHaveBeenCalledTimes(1);
		expect(result.stdout.startsWith('HEAD')).toBe(true);
		expect(result.stdout.endsWith('€TAIL')).toBe(true);
		expect(result.stderr.endsWith('ERR-TAIL')).toBe(true);
		expect(Buffer.byteLength(result.stdout)).toBeLessThan(2 * 1024 + 100);
		expect(Buffer.byteLength(result.stderr)).toBeLessThan(2 * 1024 + 100);
	}, 30_000);

	it('settles on timeout while a child floods its pipes, and a later run sees none of it', async () => {
		const { spawnFn, reap } = localSpawn();
		// A background grandchild inherits the pipes and keeps writing after its
		// parent exits; the parent itself floods until the deadline.
		const script = `
			const { spawn } = require('node:child_process');
			spawn(process.execPath, ['-e', "setInterval(() => process.stdout.write('noise'.repeat(1000)), 1)"], {
				stdio: ['ignore', 'inherit', 'inherit'],
			});
			const block = 'y'.repeat(16 * 1024);
			setInterval(() => { process.stdout.write(block); process.stderr.write(block); }, 1);
		`;
		const noisy = await runUntrusted(
			process.execPath,
			['-e', script],
			{ cwd: '/', env: {}, timeoutMs: 500, reap, outputLimits: limits },
			spawnFn
		);
		expect(noisy.timedOut).toBe(true);
		expect(reap).toHaveBeenCalledTimes(1);
		expect(Buffer.byteLength(noisy.stdout)).toBeLessThan(2 * 1024 + 100);

		const next = await runUntrusted(
			process.execPath,
			['-e', "process.stdout.write('second run')"],
			{ cwd: '/', env: {}, timeoutMs: 5_000, reap, outputLimits: limits },
			spawnFn
		);
		expect(next.stdout).toBe('second run');
		expect(next.stderr).toBe('');
		expect(next.outputTruncated).toBe(false);
	}, 30_000);
});
