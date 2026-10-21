import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	HEARTBEAT_INTERVAL_MS,
	HEARTBEAT_PATH,
	startHeartbeat,
	writeHeartbeatFile,
} from '../heartbeat.js';

const REPOSITORY_ROOT = join(import.meta.dirname, '../../../..');

describe('startHeartbeat', () => {
	beforeEach(() => {
		vi.useFakeTimers({ now: Date.UTC(2026, 9, 21, 12, 0, 0) });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('beats once at start, so a fresh worker is healthy at the first probe', () => {
		const write = vi.fn();
		const stop = startHeartbeat({ path: '/hb', write });

		expect(write).toHaveBeenCalledTimes(1);
		expect(write).toHaveBeenCalledWith('/hb', '2026-10-21T12:00:00.000Z\n');
		stop();
	});

	it('keeps beating while the worker is idle, with nothing else on the loop', () => {
		const write = vi.fn();
		const stop = startHeartbeat({ path: '/hb', write });

		vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 6);

		expect(write).toHaveBeenCalledTimes(7);
		expect(write).toHaveBeenLastCalledWith('/hb', '2026-10-21T12:01:00.000Z\n');
		stop();
	});

	it('goes stale once stopped', () => {
		const write = vi.fn();
		const stop = startHeartbeat({ path: '/hb', write });
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
		const stop = startHeartbeat({ path: '/hb', write, log });

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
