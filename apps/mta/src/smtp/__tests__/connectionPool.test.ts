import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('prom-client', () => ({
	Gauge: vi.fn(function () {
		return { set: vi.fn() };
	}),
}));
vi.mock('../../monitoring/collector.js', () => ({
	registry: { registerMetric: vi.fn() },
}));
vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import type Redis from 'ioredis';
import { SmtpConnectionPool, PoolOverCapError } from '../connectionPool.js';

// The pool holds @owlat/smtp-client connect CONFIGS (no live socket): one-
// connection-per-send (W3) means the entry is slot-accounting + config, and the
// sender opens a fresh SmtpConnection per attempt. These tests assert the config
// shape, the TLS-profile keying, and the global-slot accounting.

describe('SmtpConnectionPool', () => {
	let pool: SmtpConnectionPool;

	beforeEach(() => {
		vi.clearAllMocks();
		pool = new SmtpConnectionPool({ maxPerHost: 3, idleTimeoutMs: 30000, maxAgeMs: 300000 });
	});

	it('builds a connect config on first acquire', async () => {
		const result = await pool.acquire('mx1.example.com', '10.0.0.1', { port: 25 });

		expect(result.key).toBe('mx1.example.com:10.0.0.1:none:rt0ru0');
		expect(result.config.host).toBe('mx1.example.com');
		expect(result.config.tlsMode).toBe('starttls');
		expect(result.config.localAddress).toBe('10.0.0.1');
	});

	it('reuses the existing config for the same key', async () => {
		const first = await pool.acquire('mx1.example.com', '10.0.0.1', { port: 25 });
		pool.release(first.key);
		const second = await pool.acquire('mx1.example.com', '10.0.0.1', { port: 25 });

		expect(first.key).toBe(second.key);
		// Reuse hands back the SAME config object (no rebuild, no new slot).
		expect(first.config).toBe(second.config);
		expect(pool.size).toBe(1);
	});

	it('release works without error', async () => {
		const result = await pool.acquire('mx1.example.com', '10.0.0.1', { port: 25 });

		expect(() => pool.release(result.key)).not.toThrow();
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
			'mx1.example.com:10.0.0.1:none:rt0ru0'
		);
		expect(SmtpConnectionPool.buildKey('mx1.example.com', '10.0.0.1', 'owlat.com')).toBe(
			'mx1.example.com:10.0.0.1:owlat.com:rt0ru0'
		);
	});

	it('buildKey encodes the TLS profile (PR-22: requireTLS + rejectUnauthorized)', () => {
		const opportunistic = SmtpConnectionPool.buildKey('mx1.example.com', '10.0.0.1', undefined, {
			requireTLS: false,
			rejectUnauthorized: false,
		});
		const enforcing = SmtpConnectionPool.buildKey('mx1.example.com', '10.0.0.1', undefined, {
			requireTLS: true,
			rejectUnauthorized: true,
		});

		expect(opportunistic).toBe('mx1.example.com:10.0.0.1:none:rt0ru0');
		expect(enforcing).toBe('mx1.example.com:10.0.0.1:none:rt1ru1');
		expect(enforcing).not.toBe(opportunistic);
	});

	it('binds DANE configs to the exact policy fingerprint (fingerprint never forwarded to the client)', async () => {
		const verifyPeerCertificate = () => undefined;
		const first = await pool.acquire('mx.shared.example', '10.0.0.1', {
			port: 25,
			requireTLS: true,
			tls: { rejectUnauthorized: false, verifyPeerCertificate, danePolicyFingerprint: 'policy-a' },
		});
		pool.release(first.key);
		const second = await pool.acquire('mx.shared.example', '10.0.0.1', {
			port: 25,
			requireTLS: true,
			tls: { rejectUnauthorized: false, verifyPeerCertificate, danePolicyFingerprint: 'policy-b' },
		});

		expect(first.key).toContain('dapolicy-a');
		expect(second.key).toContain('dapolicy-b');
		expect(second.config).not.toBe(first.config);
		// The pool-only fingerprint is NEVER forwarded into the client's TLS options.
		expect(first.config.tls).not.toHaveProperty('danePolicyFingerprint');
		expect(second.config.tls).not.toHaveProperty('danePolicyFingerprint');
		// The DANE post-handshake verifier IS forwarded.
		expect(typeof first.config.tls?.verifyPeerCertificate).toBe('function');
	});

	it('rejects an unfingerprinted DANE verifier instead of pooling it unsafely', async () => {
		await expect(
			pool.acquire('mx.example', '10.0.0.1', {
				port: 25,
				tls: { verifyPeerCertificate: () => undefined },
			})
		).rejects.toThrow(/requires a policy fingerprint/);
		expect(pool.size).toBe(0);
	});

	it('pins tls.minVersion TLSv1.2 on every built config (RFC 8996/9325)', async () => {
		const { config } = await pool.acquire('mx1.example.com', '10.0.0.1', {
			port: 25,
			tls: { rejectUnauthorized: false },
		});
		expect(config.tls?.minVersion).toBe('TLSv1.2');
		expect(config.tls?.rejectUnauthorized).toBe(false);
	});

	it('pins TLSv1.2 even when the caller passes no tls options at all', async () => {
		const { config } = await pool.acquire('mx1.example.com', '10.0.0.1', { port: 25 });
		expect(config.tls?.minVersion).toBe('TLSv1.2');
	});

	it('lets the caller raise the floor to TLSv1.3 without it being clobbered', async () => {
		const { config } = await pool.acquire('mx1.example.com', '10.0.0.1', {
			port: 25,
			tls: { rejectUnauthorized: true, minVersion: 'TLSv1.3' },
		});
		expect(config.tls?.minVersion).toBe('TLSv1.3');
		expect(config.tls?.rejectUnauthorized).toBe(true);
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
		const opportunistic = await pool.acquire('mx.shared.example.com', '10.0.0.1', {
			port: 25,
			requireTLS: false,
			tls: { rejectUnauthorized: false },
		});
		pool.release(opportunistic.key);
		expect(pool.size).toBe(1);

		// An MTA-STS-enforce acquire to the SAME mx+bindIp+dkim that REQUIRES verified
		// TLS must NOT reuse the opportunistic config — a fresh entry is created.
		const enforcing = await pool.acquire('mx.shared.example.com', '10.0.0.1', {
			port: 25,
			requireTLS: true,
			tls: { rejectUnauthorized: true },
		});

		expect(enforcing.config).not.toBe(opportunistic.config);
		expect(enforcing.key).not.toBe(opportunistic.key);
		expect(pool.size).toBe(2);
		expect(enforcing.config.requireTls).toBe(true);
		expect(enforcing.config.tls?.rejectUnauthorized).toBe(true);
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
				incr: (k: string) => {
					ops.push(['incr', k]);
					return chain;
				},
				decr: (k: string) => {
					ops.push(['decr', k]);
					return chain;
				},
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
		const pool = new SmtpConnectionPool({
			maxPerHost: 100,
			idleTimeoutMs: 30000,
			maxAgeMs: 300000,
		});
		pool.enableDistributedCoordination(redis as unknown as Redis, 2, 'srv1');

		await pool.acquire('mx.example.com', '10.0.0.1', { port: 25 });
		await pool.acquire('mx.example.com', '10.0.0.2', { port: 25 });
		expect(await pool.getGlobalConnectionCount('mx.example.com')).toBe(2);

		await pool.acquire('mx.example.com', '10.0.0.3', { port: 25 }).then(
			() => expect.fail('should be over cap'),
			(err) => expect(err).toBeInstanceOf(PoolOverCapError)
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
		const pool = new SmtpConnectionPool({
			maxPerHost: 100,
			idleTimeoutMs: 30000,
			maxAgeMs: 300000,
		});
		await pool.acquire('mx.example.com', '10.0.0.1', { port: 25 });
		await pool.acquire('mx.example.com', '10.0.0.2', { port: 25 });
		await pool.acquire('mx.example.com', '10.0.0.3', { port: 25 });
		expect(pool.size).toBe(3);
		expect(await pool.getGlobalConnectionCount('mx.example.com')).toBe(0);
	});

	it('rolls back the global INCR exactly once on an over-cap reservation (count stays at cap)', async () => {
		const redis = makeRedisMock();
		const pool = new SmtpConnectionPool({
			maxPerHost: 100,
			idleTimeoutMs: 30000,
			maxAgeMs: 300000,
		});
		pool.enableDistributedCoordination(redis as unknown as Redis, 1, 'srv1');

		await pool.acquire('mx.example.com', '10.0.0.1', { port: 25 });
		expect(await pool.getGlobalConnectionCount('mx.example.com')).toBe(1);

		await expect(pool.acquire('mx.example.com', '10.0.0.2', { port: 25 })).rejects.toBeInstanceOf(
			PoolOverCapError
		);
		await expect(pool.acquire('mx.example.com', '10.0.0.3', { port: 25 })).rejects.toBeInstanceOf(
			PoolOverCapError
		);

		expect(await pool.getGlobalConnectionCount('mx.example.com')).toBe(1);
		// No new entry was created for the rejected acquires.
		expect(pool.size).toBe(1);
	});
});

// ──────────────────────────────────────────────────────────────────────────
// PR-73 regression lock: per-instance maxPerHost LRU-idle eviction + drain.
// The pool bounds concurrent connections per MX host on a single instance and,
// when full, evicts the least-recently-used IDLE entry to make room — never an
// in-flight one. closeAll() drains: it waits for in-flight sends to finish
// before tearing entries down. (RFC 5321 §4.5.4 retry/connection discipline.)
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

	it('evicts the LEAST-recently-used idle entry when the per-host cap is hit', async () => {
		const pool = new SmtpConnectionPool({ maxPerHost: 2, idleTimeoutMs: 30000, maxAgeMs: 300000 });

		const a = await pool.acquire('mx.example.com', '10.0.0.1', { port: 25 });
		pool.release(a.key); // a released at t0

		vi.advanceTimersByTime(1000);
		const b = await pool.acquire('mx.example.com', '10.0.0.2', { port: 25 });
		pool.release(b.key); // b released later → b is MORE recently used than a

		expect(pool.size).toBe(2);

		vi.advanceTimersByTime(1000);
		await pool.acquire('mx.example.com', '10.0.0.3', { port: 25 });

		expect(pool.size).toBe(2);
		// `a` (LRU idle) was evicted; re-acquiring its key rebuilds a fresh config.
		const aAgain = await pool.acquire('mx.example.com', '10.0.0.1', { port: 25 });
		expect(aAgain.config).not.toBe(a.config);
	});

	it('does NOT evict an in-flight entry even when the per-host cap is hit', async () => {
		const pool = new SmtpConnectionPool({ maxPerHost: 1, idleTimeoutMs: 30000, maxAgeMs: 300000 });

		const a = await pool.acquire('mx.example.com', '10.0.0.1', { port: 25 });
		// a.inFlight === 1 — it must NOT be evicted; the pool grows past cap instead.
		const b = await pool.acquire('mx.example.com', '10.0.0.2', { port: 25 });

		expect(b.config).not.toBe(a.config);
		expect(pool.size).toBe(2);
		// `a` survived: reusing its key returns the SAME config object.
		const aAgain = await pool.acquire('mx.example.com', '10.0.0.1', { port: 25 });
		expect(aAgain.config).toBe(a.config);
	});

	it('aged-out idle entries are evicted by the periodic sweep', async () => {
		const pool = new SmtpConnectionPool({ maxPerHost: 5, idleTimeoutMs: 30000, maxAgeMs: 300000 });
		const a = await pool.acquire('mx.example.com', '10.0.0.1', { port: 25 });
		pool.release(a.key);
		expect(pool.size).toBe(1);

		pool.startEviction(10_000);
		vi.advanceTimersByTime(40_000);
		expect(pool.size).toBe(0);

		await pool.closeAll();
	});
});

describe('SmtpConnectionPool — drain on closeAll (PR-73)', () => {
	beforeEach(() => vi.clearAllMocks());

	it('waits for in-flight sends to finish before tearing the pool down', async () => {
		const pool = new SmtpConnectionPool({ maxPerHost: 3, idleTimeoutMs: 30000, maxAgeMs: 300000 });

		const a = await pool.acquire('mx.example.com', '10.0.0.1', { port: 25 });
		expect(pool.size).toBe(1);

		let closed = false;
		const closing = pool.closeAll(5000).then(() => {
			closed = true;
		});

		await new Promise((r) => setTimeout(r, 250));
		expect(closed).toBe(false);

		pool.release(a.key);
		await closing;

		expect(closed).toBe(true);
		expect(pool.size).toBe(0);
	});

	it('tears down immediately when nothing is in-flight', async () => {
		const pool = new SmtpConnectionPool({ maxPerHost: 3, idleTimeoutMs: 30000, maxAgeMs: 300000 });
		const a = await pool.acquire('mx.example.com', '10.0.0.1', { port: 25 });
		pool.release(a.key);

		await pool.closeAll();
		expect(pool.size).toBe(0);
	});
});
