import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Redis from 'ioredis';
import { startIpAuditor, type IpAuditConfig, type IpAuditDeps } from '../ipAudit.js';
import type { Port25ProbeResult } from '../port25Probe.js';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const IP = '203.0.113.10';
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function codedError(code: string): Error & { code: string } {
	const error = new Error(code) as Error & { code: string };
	error.code = code;
	return error;
}

function config(): IpAuditConfig {
	return {
		ipPools: { transactional: [IP], campaign: [] },
		ehloHostname: 'mail.example.com',
		ehloHostnames: {},
	};
}

function port25Open(ip: string): Promise<Port25ProbeResult> {
	return Promise.resolve({ ip, status: 'open', reason: 'connected', checkedAt: 1, targets: [] });
}

function deps(now: () => number): IpAuditDeps {
	return {
		now,
		dns: {
			resolve4: (hostname: string) =>
				hostname === 'mail.example.com'
					? Promise.resolve([IP])
					: Promise.reject(codedError('ENOTFOUND')),
			reverse: () => Promise.resolve(['mail.example.com']),
			resolve6: () => Promise.resolve([]),
		},
		port25: port25Open,
		neighbourSampleSize: 0,
		zoneTimeoutMs: 50,
	};
}

function fakeRedis(): { redis: Redis; store: Map<string, string>; writes: () => number } {
	const store = new Map<string, string>();
	let writes = 0;
	const redis = {
		get: (key: string) => Promise.resolve(store.get(key) ?? null),
		set: (key: string, value: string) => {
			writes += 1;
			store.set(key, value);
			return Promise.resolve('OK');
		},
	} as unknown as Redis;
	return { redis, store, writes: () => writes };
}

/**
 * The whole point of a PRE-flight audit is that it has already run by the time
 * the operator asks. Leadership is acquired asynchronously, so a leader-gated
 * boot sweep would always no-op and the first audit would land up to an hour
 * after install — with the audit endpoint empty throughout.
 */
describe('startIpAuditor', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
	});

	it('runs the boot sweep even though leadership is not held yet', async () => {
		const { redis, store } = fakeRedis();
		const clock = 1_700_000_000_000;
		const interval = startIpAuditor(
			redis,
			config(),
			() => false,
			deps(() => clock)
		);
		await vi.advanceTimersByTimeAsync(0);
		expect(store.has(`mta:ip-audit:${IP}`)).toBe(true);
		clearInterval(interval);
	});

	it('does not re-probe an address audited minutes ago', async () => {
		const { redis, writes } = fakeRedis();
		let clock = 1_700_000_000_000;
		const first = startIpAuditor(
			redis,
			config(),
			() => true,
			deps(() => clock)
		);
		await vi.advanceTimersByTimeAsync(0);
		expect(writes()).toBe(1);
		clearInterval(first);

		clock += 5 * 60 * 1000;
		const second = startIpAuditor(
			redis,
			config(),
			() => true,
			deps(() => clock)
		);
		await vi.advanceTimersByTimeAsync(0);
		expect(writes()).toBe(1);
		clearInterval(second);
	});

	it('leader-gates the periodic tick', async () => {
		const { redis, writes } = fakeRedis();
		let clock = 1_700_000_000_000;
		let leader = false;
		const interval = startIpAuditor(
			redis,
			config(),
			() => leader,
			deps(() => clock)
		);
		await vi.advanceTimersByTimeAsync(0);
		expect(writes()).toBe(1);

		// A day later the audit is due again, but this process is not the leader.
		clock += DAY_MS;
		await vi.advanceTimersByTimeAsync(HOUR_MS);
		expect(writes()).toBe(1);

		leader = true;
		await vi.advanceTimersByTimeAsync(HOUR_MS);
		expect(writes()).toBe(2);
		clearInterval(interval);
	});

	it('never rejects when the sweep itself blows up', async () => {
		const unhandled = vi.fn();
		process.on('unhandledRejection', unhandled);
		const redis = {
			get: () => Promise.reject(new Error('redis is gone')),
			set: () => Promise.reject(new Error('redis is gone')),
		} as unknown as Redis;
		const interval = startIpAuditor(
			redis,
			config(),
			() => true,
			deps(() => 1)
		);
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(HOUR_MS);
		process.off('unhandledRejection', unhandled);
		expect(unhandled).not.toHaveBeenCalled();
		clearInterval(interval);
	});
});
