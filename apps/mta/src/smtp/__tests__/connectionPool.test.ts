import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('nodemailer', () => ({
	default: {
		// A FRESH transport per call so tests can assert transport identity
		// (e.g. that a strict-TLS acquire is NOT served a pooled opportunistic one).
		createTransport: vi.fn(() => ({
			sendMail: vi.fn(),
			close: vi.fn(),
		})),
	},
}));
vi.mock('prom-client', () => ({
	Gauge: vi.fn(function () { return { set: vi.fn() }; }),
}));
vi.mock('../../monitoring/collector.js', () => ({
	registry: { registerMetric: vi.fn() },
}));
vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import type Redis from 'ioredis';
import { SmtpConnectionPool, PoolOverCapError } from '../connectionPool.js';
import nodemailer from 'nodemailer';

describe('SmtpConnectionPool', () => {
	let pool: SmtpConnectionPool;

	beforeEach(() => {
		vi.clearAllMocks();
		pool = new SmtpConnectionPool({ maxPerHost: 3, idleTimeoutMs: 30000, maxAgeMs: 300000 });
	});

	it('creates new transport on first acquire', async () => {
		const result = await pool.acquire('mx1.example.com', '10.0.0.1', { port: 25 });

		expect(result.key).toBe('mx1.example.com:10.0.0.1:none:rt0ru0');
		expect(result.transport).toBeDefined();
		expect(nodemailer.createTransport).toHaveBeenCalledTimes(1);
	});

	it('reuses existing transport for same key', async () => {
		const first = await pool.acquire('mx1.example.com', '10.0.0.1', { port: 25 });
		pool.release(first.key);
		const second = await pool.acquire('mx1.example.com', '10.0.0.1', { port: 25 });

		expect(first.key).toBe(second.key);
		expect(first.transport).toBe(second.transport);
		// createTransport should only be called once since the second acquire reuses
		expect(nodemailer.createTransport).toHaveBeenCalledTimes(1);
	});

	it('release works without error', async () => {
		const result = await pool.acquire('mx1.example.com', '10.0.0.1', { port: 25 });

		expect(() => pool.release(result.key)).not.toThrow();
		// Releasing a non-existent key should also not throw
		expect(() => pool.release('non-existent-key')).not.toThrow();
	});

	it('size tracks pool entries', async () => {
		expect(pool.size).toBe(0);

		await pool.acquire('mx1.example.com', '10.0.0.1', { port: 25 });
		expect(pool.size).toBe(1);

		await pool.acquire('mx2.example.com', '10.0.0.1', { port: 25 });
		expect(pool.size).toBe(2);
	});

	it('buildKey produces correct format', () => {
		expect(SmtpConnectionPool.buildKey('mx1.example.com', '10.0.0.1')).toBe(
			'mx1.example.com:10.0.0.1:none:rt0ru0',
		);
		expect(SmtpConnectionPool.buildKey('mx1.example.com', '10.0.0.1', 'owlat.com')).toBe(
			'mx1.example.com:10.0.0.1:owlat.com:rt0ru0',
		);
	});

	it('buildKey encodes the TLS profile (PR-22: requireTLS + rejectUnauthorized)', () => {
		// Opportunistic, non-verifying — the default bucket.
		const opportunistic = SmtpConnectionPool.buildKey('mx1.example.com', '10.0.0.1', undefined, {
			requireTLS: false,
			rejectUnauthorized: false,
		});
		// MTA-STS enforce — STARTTLS required AND certificate verified.
		const enforcing = SmtpConnectionPool.buildKey('mx1.example.com', '10.0.0.1', undefined, {
			requireTLS: true,
			rejectUnauthorized: true,
		});

		expect(opportunistic).toBe('mx1.example.com:10.0.0.1:none:rt0ru0');
		expect(enforcing).toBe('mx1.example.com:10.0.0.1:none:rt1ru1');
		// The whole point: an enforcing send must never collide with an
		// opportunistic transport to the same shared MX.
		expect(enforcing).not.toBe(opportunistic);
	});

	it('pins tls.minVersion TLSv1.2 on every created transport (RFC 8996/9325)', async () => {
		// Caller passes a tls block WITHOUT minVersion — the pool must still pin the floor.
		await pool.acquire('mx1.example.com', '10.0.0.1', {
			port: 25,
			tls: { rejectUnauthorized: false },
		});

		expect(nodemailer.createTransport).toHaveBeenCalledWith(
			expect.objectContaining({
				tls: expect.objectContaining({ minVersion: 'TLSv1.2', rejectUnauthorized: false }),
			}),
		);
	});

	it('pins TLSv1.2 even when the caller passes no tls options at all', async () => {
		await pool.acquire('mx1.example.com', '10.0.0.1', { port: 25 });

		expect(nodemailer.createTransport).toHaveBeenCalledWith(
			expect.objectContaining({
				tls: expect.objectContaining({ minVersion: 'TLSv1.2' }),
			}),
		);
	});

	it('lets the caller raise the floor to TLSv1.3 without it being clobbered', async () => {
		await pool.acquire('mx1.example.com', '10.0.0.1', {
			port: 25,
			tls: { rejectUnauthorized: true, minVersion: 'TLSv1.3' },
		});

		expect(nodemailer.createTransport).toHaveBeenCalledWith(
			expect.objectContaining({
				tls: expect.objectContaining({ minVersion: 'TLSv1.3', rejectUnauthorized: true }),
			}),
		);
	});

	it('closeAll clears pool', async () => {
		const a = await pool.acquire('mx1.example.com', '10.0.0.1', { port: 25 });
		pool.release(a.key);
		const b = await pool.acquire('mx2.example.com', '10.0.0.1', { port: 25 });
		pool.release(b.key);

		expect(pool.size).toBe(2);

		await pool.closeAll();

		expect(pool.size).toBe(0);
	});

	it('TLS strictness participates in pool identity (PR-22: MTA-STS-enforce downgrade)', async () => {
		// First, an opportunistic, non-verifying send to a shared MX.
		const opportunistic = await pool.acquire('mx.shared.example.com', '10.0.0.1', {
			port: 25,
			requireTLS: false,
			tls: { rejectUnauthorized: false },
		});
		pool.release(opportunistic.key);
		expect(nodemailer.createTransport).toHaveBeenCalledTimes(1);

		// Then an MTA-STS-enforce send to the SAME mxHost+bindIp+dkimDomain that
		// REQUIRES STARTTLS and certificate verification. It must NOT reuse the
		// opportunistic transport — a fresh, properly-configured one is created.
		const enforcing = await pool.acquire('mx.shared.example.com', '10.0.0.1', {
			port: 25,
			requireTLS: true,
			tls: { rejectUnauthorized: true },
		});

		expect(enforcing.transport).not.toBe(opportunistic.transport);
		expect(enforcing.key).not.toBe(opportunistic.key);
		expect(nodemailer.createTransport).toHaveBeenCalledTimes(2);
		expect(pool.size).toBe(2);

		// And the enforcing transport carried the strict TLS settings to the factory.
		const createTransport = vi.mocked(nodemailer.createTransport);
		const enforcingCall = createTransport.mock.calls[1]?.[0];
		expect(enforcingCall).toMatchObject({
			requireTLS: true,
			tls: { rejectUnauthorized: true },
		});
	});
});

/** Minimal in-memory ioredis stand-in for the global-counter coordination. */
function makeRedisMock() {
	const store = new Map<string, number>();
	const mock = {
		incr: vi.fn(async (k: string) => {
			const v = (store.get(k) ?? 0) + 1;
			store.set(k, v);
			return v;
		}),
		decr: vi.fn(async (k: string) => {
			const v = (store.get(k) ?? 0) - 1;
			store.set(k, v);
			return v;
		}),
		expire: vi.fn(async () => 1),
		get: vi.fn(async (k: string) => (store.has(k) ? String(store.get(k)) : null)),
		pipeline: vi.fn(() => {
			const ops: Array<['incr' | 'decr', string]> = [];
			const chain = {
				incr: (k: string) => { ops.push(['incr', k]); return chain; },
				decr: (k: string) => { ops.push(['decr', k]); return chain; },
				expire: () => chain,
				exec: async () => {
					for (const [op, k] of ops) {
						store.set(k, (store.get(k) ?? 0) + (op === 'incr' ? 1 : -1));
					}
					return [];
				},
			};
			return chain;
		}),
		_store: store,
	};
	return mock;
}

describe('SmtpConnectionPool — distributed coordination', () => {
	beforeEach(() => vi.clearAllMocks());

	it('enforces the global per-host cap atomically and rolls back over-cap reservations', async () => {
		const redis = makeRedisMock();
		// High per-host limit so the GLOBAL cap is the gate under test.
		const pool = new SmtpConnectionPool({ maxPerHost: 100, idleTimeoutMs: 30000, maxAgeMs: 300000 });
		pool.enableDistributedCoordination(redis as unknown as Redis, 2, 'srv1');

		// Distinct bindIps → distinct keys → distinct transports to the SAME host.
		await pool.acquire('mx.example.com', '10.0.0.1', { port: 25 });
		await pool.acquire('mx.example.com', '10.0.0.2', { port: 25 });
		expect(await pool.getGlobalConnectionCount('mx.example.com')).toBe(2);

		// Third new connection is over the global cap of 2 → throws, INCR rolled back.
		await expect(pool.acquire('mx.example.com', '10.0.0.3', { port: 25 })).rejects.toBeInstanceOf(
			PoolOverCapError,
		);
		expect(await pool.getGlobalConnectionCount('mx.example.com')).toBe(2); // not 3
	});

	it('reuse takes no new global slot', async () => {
		const redis = makeRedisMock();
		const pool = new SmtpConnectionPool({ maxPerHost: 3, idleTimeoutMs: 30000, maxAgeMs: 300000 });
		pool.enableDistributedCoordination(redis as unknown as Redis, 10, 'srv1');

		const a = await pool.acquire('mx.example.com', '10.0.0.1', { port: 25 });
		pool.release(a.key);
		await pool.acquire('mx.example.com', '10.0.0.1', { port: 25 }); // reuse same key

		expect(await pool.getGlobalConnectionCount('mx.example.com')).toBe(1); // not 2
	});

	it('per-host eviction releases the evicted global slot (net count unchanged)', async () => {
		const redis = makeRedisMock();
		const pool = new SmtpConnectionPool({ maxPerHost: 2, idleTimeoutMs: 30000, maxAgeMs: 300000 });
		pool.enableDistributedCoordination(redis as unknown as Redis, 10, 'srv1');

		const a = await pool.acquire('mx.example.com', '10.0.0.1', { port: 25 });
		pool.release(a.key);
		const b = await pool.acquire('mx.example.com', '10.0.0.2', { port: 25 });
		pool.release(b.key);
		expect(await pool.getGlobalConnectionCount('mx.example.com')).toBe(2);

		// Third acquire to the same host evicts the LRU idle entry (decr) then
		// reserves a slot for the new transport (incr) — net 2, balanced.
		await pool.acquire('mx.example.com', '10.0.0.3', { port: 25 });
		expect(await pool.getGlobalConnectionCount('mx.example.com')).toBe(2);
		expect(pool.size).toBe(2);
	});

	it('closeAll releases every global slot', async () => {
		const redis = makeRedisMock();
		const pool = new SmtpConnectionPool({ maxPerHost: 3, idleTimeoutMs: 30000, maxAgeMs: 300000 });
		pool.enableDistributedCoordination(redis as unknown as Redis, 10, 'srv1');

		const a = await pool.acquire('mx.example.com', '10.0.0.1', { port: 25 });
		pool.release(a.key);
		const b = await pool.acquire('mx2.example.com', '10.0.0.1', { port: 25 });
		pool.release(b.key);
		expect(await pool.getGlobalConnectionCount('mx.example.com')).toBe(1);
		expect(await pool.getGlobalConnectionCount('mx2.example.com')).toBe(1);

		await pool.closeAll();

		expect(await pool.getGlobalConnectionCount('mx.example.com')).toBe(0);
		expect(await pool.getGlobalConnectionCount('mx2.example.com')).toBe(0);
	});

	it('fail-opens when coordination is disabled (no redis)', async () => {
		const pool = new SmtpConnectionPool({ maxPerHost: 100, idleTimeoutMs: 30000, maxAgeMs: 300000 });
		// No enableDistributedCoordination → no cap, no tracking.
		await pool.acquire('mx.example.com', '10.0.0.1', { port: 25 });
		await pool.acquire('mx.example.com', '10.0.0.2', { port: 25 });
		await pool.acquire('mx.example.com', '10.0.0.3', { port: 25 });
		expect(pool.size).toBe(3);
		expect(await pool.getGlobalConnectionCount('mx.example.com')).toBe(0);
	});

	it('rolls back the global INCR exactly once on an over-cap reservation (count stays at cap)', async () => {
		const redis = makeRedisMock();
		const pool = new SmtpConnectionPool({ maxPerHost: 100, idleTimeoutMs: 30000, maxAgeMs: 300000 });
		pool.enableDistributedCoordination(redis as unknown as Redis, 1, 'srv1');

		await pool.acquire('mx.example.com', '10.0.0.1', { port: 25 });
		expect(await pool.getGlobalConnectionCount('mx.example.com')).toBe(1);

		// Two more over-cap attempts both throw and both roll their INCR back.
		await expect(pool.acquire('mx.example.com', '10.0.0.2', { port: 25 })).rejects.toBeInstanceOf(
			PoolOverCapError,
		);
		await expect(pool.acquire('mx.example.com', '10.0.0.3', { port: 25 })).rejects.toBeInstanceOf(
			PoolOverCapError,
		);

		// Count is still exactly the cap — never leaked above it, never went negative.
		expect(await pool.getGlobalConnectionCount('mx.example.com')).toBe(1);
		// No transport was created for the rejected acquires.
		expect(nodemailer.createTransport).toHaveBeenCalledTimes(1);
	});
});

// ──────────────────────────────────────────────────────────────────────────
// PR-73 regression lock: per-instance maxPerHost LRU-idle eviction + drain.
// The pool bounds concurrent transports per MX host on a single instance and,
// when full, evicts the least-recently-used IDLE entry to make room — never an
// in-flight one. closeAll() drains: it waits for in-flight sends to finish
// before tearing connections down. Bounding concurrency per receiving MX is the
// politeness ISPs expect (RFC 5321 §4.5.4 retry/connection discipline).
// ──────────────────────────────────────────────────────────────────────────
describe('SmtpConnectionPool — per-instance LRU-idle eviction (PR-73)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-03-22T12:00:00Z'));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('evicts the LEAST-recently-used idle transport when the per-host cap is hit', async () => {
		const pool = new SmtpConnectionPool({ maxPerHost: 2, idleTimeoutMs: 30000, maxAgeMs: 300000 });

		// Two distinct transports to the same host (distinct bindIps → distinct keys).
		const a = await pool.acquire('mx.example.com', '10.0.0.1', { port: 25 });
		pool.release(a.key); // a released at t0

		vi.advanceTimersByTime(1000);
		const b = await pool.acquire('mx.example.com', '10.0.0.2', { port: 25 });
		pool.release(b.key); // b released at t0+1s → b is MORE recently used than a

		expect(pool.size).toBe(2);

		// Third acquire to the same host is over the per-host cap of 2. The LRU
		// idle entry (a, oldest lastUsedAt) is evicted; b (newer) survives.
		vi.advanceTimersByTime(1000);
		const c = await pool.acquire('mx.example.com', '10.0.0.3', { port: 25 });

		expect(pool.size).toBe(2);
		// `a` was closed and removed; `b` and `c` remain.
		expect(vi.mocked(a.transport.close)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(b.transport.close)).not.toHaveBeenCalled();
		expect(vi.mocked(c.transport.close)).not.toHaveBeenCalled();
	});

	it('does NOT evict an in-flight transport even when the per-host cap is hit', async () => {
		const pool = new SmtpConnectionPool({ maxPerHost: 1, idleTimeoutMs: 30000, maxAgeMs: 300000 });

		// One transport, still in-flight (never released).
		const a = await pool.acquire('mx.example.com', '10.0.0.1', { port: 25 });
		// a.inFlight === 1 — it must NOT be evicted.

		// A second acquire to the same host is over the cap. There is no idle
		// entry to evict, so the in-flight one is left alone and a new transport
		// is added (the pool grows past maxPerHost rather than killing a live send).
		const b = await pool.acquire('mx.example.com', '10.0.0.2', { port: 25 });

		expect(vi.mocked(a.transport.close)).not.toHaveBeenCalled();
		expect(b.transport).not.toBe(a.transport);
		expect(pool.size).toBe(2);
	});

	it('aged-out idle transports are evicted by the periodic sweep', async () => {
		const pool = new SmtpConnectionPool({ maxPerHost: 5, idleTimeoutMs: 30000, maxAgeMs: 300000 });
		const a = await pool.acquire('mx.example.com', '10.0.0.1', { port: 25 });
		pool.release(a.key);
		expect(pool.size).toBe(1);

		pool.startEviction(10_000);

		// Past the idle timeout (30s) → the next sweep evicts it.
		vi.advanceTimersByTime(40_000);
		expect(pool.size).toBe(0);
		expect(vi.mocked(a.transport.close)).toHaveBeenCalledTimes(1);

		await pool.closeAll();
	});
});

describe('SmtpConnectionPool — drain on closeAll (PR-73)', () => {
	beforeEach(() => vi.clearAllMocks());

	it('waits for in-flight sends to finish before tearing the pool down', async () => {
		const pool = new SmtpConnectionPool({ maxPerHost: 3, idleTimeoutMs: 30000, maxAgeMs: 300000 });

		// Acquire and DO NOT release → one in-flight send.
		const a = await pool.acquire('mx.example.com', '10.0.0.1', { port: 25 });
		expect(pool.size).toBe(1);

		// Kick off closeAll with a generous drain window; it should block on the
		// in-flight count until we release.
		let closed = false;
		const closing = pool.closeAll(5000).then(() => {
			closed = true;
		});

		// Let a few drain-poll cycles run; closeAll must still be waiting.
		await new Promise((r) => setTimeout(r, 250));
		expect(closed).toBe(false);
		expect(vi.mocked(a.transport.close)).not.toHaveBeenCalled();

		// Release the in-flight send → drain completes and the transport closes.
		pool.release(a.key);
		await closing;

		expect(closed).toBe(true);
		expect(pool.size).toBe(0);
		expect(vi.mocked(a.transport.close)).toHaveBeenCalledTimes(1);
	});

	it('tears down immediately when nothing is in-flight', async () => {
		const pool = new SmtpConnectionPool({ maxPerHost: 3, idleTimeoutMs: 30000, maxAgeMs: 300000 });
		const a = await pool.acquire('mx.example.com', '10.0.0.1', { port: 25 });
		pool.release(a.key);

		await pool.closeAll();
		expect(pool.size).toBe(0);
		expect(vi.mocked(a.transport.close)).toHaveBeenCalledTimes(1);
	});
});
