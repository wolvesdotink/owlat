import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	MAX_TIMER_DELAY_MS,
	PLUGIN_JOB_HEARTBEAT_DEFAULT_MS,
	POLL_INTERVAL_DEFAULT_MS,
	readIntEnv,
	readWorkerTimers,
} from '../env.js';

/**
 * The worker's timer settings used to go through a bare `Number(...)`: `10s`
 * became NaN and `0` was accepted, and Node runs a timer with either delay
 * after 1 ms, so the poll loop or the plugin-job heartbeat hit Convex in a tight
 * loop. Every malformed value must now throw an error that names the variable.
 */
describe('readIntEnv', () => {
	const options = { default: 7, min: 1, max: 100 };

	it('returns the default for an unset, empty or blank value', () => {
		expect(readIntEnv({}, 'X', options)).toBe(7);
		expect(readIntEnv({ X: '' }, 'X', options)).toBe(7);
		expect(readIntEnv({ X: '   ' }, 'X', options)).toBe(7);
	});

	it('parses a plain decimal integer, trimming whitespace', () => {
		expect(readIntEnv({ X: '42' }, 'X', options)).toBe(42);
		expect(readIntEnv({ X: ' 42 ' }, 'X', options)).toBe(42);
		expect(readIntEnv({ X: '+42' }, 'X', options)).toBe(42);
	});

	it.each(['10s', '10_000', '1e3', '1.5', '0x10', 'NaN', 'Infinity', '-', '9007199254740993'])(
		'rejects %j',
		(raw) => {
			expect(() => readIntEnv({ X: raw }, 'X', { default: 7 })).toThrow(
				`X must be an integer, got ${JSON.stringify(raw)}`
			);
		}
	);

	it('rejects values outside the range and names it', () => {
		expect(() => readIntEnv({ X: '0' }, 'X', options)).toThrow(
			'X must be an integer between 1 and 100, got "0"'
		);
		expect(() => readIntEnv({ X: '101' }, 'X', options)).toThrow('between 1 and 100');
		expect(() => readIntEnv({ X: '-5' }, 'X', { default: 7, min: 1 })).toThrow(
			'X must be an integer of at least 1, got "-5"'
		);
		expect(() => readIntEnv({ X: '5' }, 'X', { default: 7, max: 4 })).toThrow(
			'X must be an integer of at most 4, got "5"'
		);
	});
});

describe('readWorkerTimers', () => {
	it('uses the defaults when nothing is set', () => {
		expect(readWorkerTimers({})).toEqual({
			pollIntervalMs: POLL_INTERVAL_DEFAULT_MS,
			pluginJobHeartbeatMs: PLUGIN_JOB_HEARTBEAT_DEFAULT_MS,
		});
	});

	it('accepts valid overrides', () => {
		expect(
			readWorkerTimers({ POLL_INTERVAL_MS: '30000', PLUGIN_JOB_HEARTBEAT_MS: '2000' })
		).toEqual({ pollIntervalMs: 30_000, pluginJobHeartbeatMs: 2_000 });
	});

	it.each(['10s', '10_000', '0', '-1', '999', String(MAX_TIMER_DELAY_MS + 1)])(
		'rejects POLL_INTERVAL_MS=%j',
		(raw) => {
			expect(() => readWorkerTimers({ POLL_INTERVAL_MS: raw })).toThrow(/^POLL_INTERVAL_MS /);
		}
	);

	it.each(['5s', '5_000', '0', '-1', '499', String(MAX_TIMER_DELAY_MS + 1)])(
		'rejects PLUGIN_JOB_HEARTBEAT_MS=%j',
		(raw) => {
			expect(() => readWorkerTimers({ PLUGIN_JOB_HEARTBEAT_MS: raw })).toThrow(
				/^PLUGIN_JOB_HEARTBEAT_MS /
			);
		}
	);
});

describe('sandbox uid/gid', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.resetModules();
	});

	it('refuses a malformed CODE_SANDBOX_UID when the module loads', async () => {
		vi.stubEnv('CODE_SANDBOX_UID', '0');
		vi.resetModules();
		await expect(import('../sandbox.js')).rejects.toThrow(
			'CODE_SANDBOX_UID must be an integer of at least 1, got "0"'
		);
	});

	it('refuses a malformed CODE_SANDBOX_GID when the module loads', async () => {
		vi.stubEnv('CODE_SANDBOX_GID', 'sandbox');
		vi.resetModules();
		await expect(import('../sandbox.js')).rejects.toThrow(/^CODE_SANDBOX_GID /);
	});
});
