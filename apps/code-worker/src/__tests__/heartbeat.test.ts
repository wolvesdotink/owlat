import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	HEARTBEAT_DIR,
	HEARTBEAT_INTERVAL_MS,
	HEARTBEAT_PATH,
	prepareHeartbeatDir,
	startHeartbeat,
	writeHeartbeatFile,
} from '../heartbeat.js';

const REPOSITORY_ROOT = join(import.meta.dirname, '../../../..');

const noPrepare = () => {};

describe('startHeartbeat', () => {
	beforeEach(() => {
		vi.useFakeTimers({ now: Date.UTC(2026, 9, 21, 12, 0, 0) });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('prepares the private directory before the first write', () => {
		const calls: string[] = [];
		const stop = startHeartbeat({
			path: '/private/hb',
			prepare: (dir) => calls.push(`prepare ${dir}`),
			write: (path) => calls.push(`write ${path}`),
		});

		expect(calls).toEqual(['prepare /private', 'write /private/hb']);
		stop();
	});

	it('refuses to start when the directory cannot be made private', () => {
		const write = vi.fn();
		const prepare = () => {
			throw new Error('not private');
		};

		expect(() => startHeartbeat({ path: '/private/hb', write, prepare })).toThrow('not private');
		vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 3);
		expect(write).not.toHaveBeenCalled();
	});

	it('beats once at start, so a fresh worker is healthy at the first probe', () => {
		const write = vi.fn();
		const stop = startHeartbeat({ path: '/hb', write, prepare: noPrepare });

		expect(write).toHaveBeenCalledTimes(1);
		expect(write).toHaveBeenCalledWith('/hb', '2026-10-21T12:00:00.000Z\n');
		stop();
	});

	it('keeps beating while the worker is idle, with nothing else on the loop', () => {
		const write = vi.fn();
		const stop = startHeartbeat({ path: '/hb', write, prepare: noPrepare });

		vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 6);

		expect(write).toHaveBeenCalledTimes(7);
		expect(write).toHaveBeenLastCalledWith('/hb', '2026-10-21T12:01:00.000Z\n');
		stop();
	});

	it('goes stale once stopped', () => {
		const write = vi.fn();
		const stop = startHeartbeat({ path: '/hb', write, prepare: noPrepare });
		stop();

		vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 20);

		expect(write).toHaveBeenCalledTimes(1);
	});

	it('logs a failing write once, and again when it recovers', () => {
		const log = vi.fn();
		let broken = true;
		const write = vi.fn(() => {
			if (broken) throw new Error('ENOSPC: no space left on device');
		});
		const stop = startHeartbeat({ path: '/hb', write, log, prepare: noPrepare });

		vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 3);
		expect(log).toHaveBeenCalledTimes(1);
		expect(log).toHaveBeenCalledWith(
			'Could not write heartbeat file /hb: ENOSPC: no space left on device'
		);

		broken = false;
		vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
		expect(log).toHaveBeenCalledTimes(2);
		expect(log).toHaveBeenLastCalledWith('Heartbeat file /hb is writable again');
		stop();
	});
});

describe('writeHeartbeatFile', () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'owlat-heartbeat-'));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it('replaces the file whole and leaves no staging file behind', () => {
		const path = join(dir, 'heartbeat');
		writeHeartbeatFile(path, 'first\n');
		writeHeartbeatFile(path, 'second\n');

		expect(readFileSync(path, 'utf8')).toBe('second\n');
		expect(readdirSync(dir)).toEqual(['heartbeat']);
	});
});

describe('the heartbeat directory', () => {
	let shared: string;

	beforeEach(() => {
		// Stands in for the /tmp a sandboxed task can also write to.
		shared = mkdtempSync(join(tmpdir(), 'owlat-heartbeat-shared-'));
	});

	afterEach(() => {
		rmSync(shared, { recursive: true, force: true });
	});

	it('keeps the file and its staging name in a directory of their own', () => {
		expect(HEARTBEAT_PATH.startsWith(`${HEARTBEAT_DIR}/`)).toBe(true);
		expect(HEARTBEAT_DIR.startsWith('/tmp/')).toBe(true);
	});

	it('creates the directory with no group or other access', () => {
		const dir = join(shared, 'owlat-code-worker');
		prepareHeartbeatDir(dir);

		expect(statSync(dir).isDirectory()).toBe(true);
		expect(statSync(dir).mode & 0o777).toBe(0o700);
	});

	it('keeps beating when names in the shared directory are planted', () => {
		// The names a task could plant when the file lived directly in /tmp.
		mkdirSync(join(shared, 'owlat-code-worker.heartbeat'));
		mkdirSync(join(shared, 'owlat-code-worker.heartbeat.tmp'));
		const log = vi.fn();
		const path = join(shared, 'owlat-code-worker', 'heartbeat');

		const stop = startHeartbeat({ path, log });
		stop();

		expect(log).not.toHaveBeenCalled();
		expect(readFileSync(path, 'utf8')).toMatch(/^\d{4}-\d\d-\d\dT/);
		expect(readdirSync(join(shared, 'owlat-code-worker'))).toEqual(['heartbeat']);
	});

	it('refuses a directory others can reach', () => {
		const dir = join(shared, 'owlat-code-worker');
		mkdirSync(dir);
		chmodSync(dir, 0o777);

		expect(() => prepareHeartbeatDir(dir)).toThrow('not a private directory');
	});

	it('refuses a symlink, even to a private directory', () => {
		const target = join(shared, 'elsewhere');
		mkdirSync(target, { mode: 0o700 });
		const dir = join(shared, 'owlat-code-worker');
		symlinkSync(target, dir);

		expect(() => prepareHeartbeatDir(dir)).toThrow('not a private directory');
	});

	it('refuses a file in its place', () => {
		const dir = join(shared, 'owlat-code-worker');
		writeFileSync(dir, '');

		expect(() => prepareHeartbeatDir(dir)).toThrow('not a private directory');
	});

	it('accepts the directory it made on an earlier call', () => {
		const dir = join(shared, 'owlat-code-worker');
		prepareHeartbeatDir(dir);

		expect(() => prepareHeartbeatDir(dir)).not.toThrow();
	});
});

describe.each(['docker-compose.yml', 'infra/templates/docker-compose.vps.yml'])(
	'%s code-worker healthcheck',
	(file) => {
		const compose = readFileSync(join(REPOSITORY_ROOT, file), 'utf8');
		const start = compose.indexOf('\n  code-worker:\n');
		const end = compose.indexOf('\n  convex-fn-proxy:\n', start);
		const service = compose.slice(start, end);

		const freshness = new RegExp(`find ${HEARTBEAT_PATH} -mmin -(\\d+)`).exec(service);

		it('reads the file this module writes', () => {
			expect(freshness).not.toBeNull();
		});

		it('allows several missed beats before calling the worker stale', () => {
			expect(Number(freshness?.[1]) * 60_000).toBeGreaterThanOrEqual(HEARTBEAT_INTERVAL_MS * 6);
		});
	}
);
