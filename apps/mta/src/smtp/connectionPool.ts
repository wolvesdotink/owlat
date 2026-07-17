/**
 * SMTP Connection Pool
 *
 * Maintains reusable @owlat/smtp-client CONNECT CONFIGS keyed by
 * {mxHost}:{bindIp}:{dkimDomain}:{tlsProfile}, where tlsProfile encodes
 * requireTLS, tls.rejectUnauthorized, and any DANE policy fingerprint. The TLS
 * profile MUST be part of the key: many domains share an MX (Google/O365), so
 * without it an MTA-STS-enforce send (requireTLS + verifying) would silently
 * reuse an earlier opportunistic, non-verifying entry to the same MX — a
 * STARTTLS-stripping / enforcement bypass on exactly the high-value shared-MX
 * providers (RFC 8461 §5, RFC 7435).
 * Evicts idle and aged-out entries automatically.
 *
 * TRUE SOCKET REUSE (X1): a pool entry may park ONE idle, live
 * {@link SmtpConnection}. Consecutive jobs to the same
 * {mx, bindIp, dkimDomain, tlsProfile} reuse that socket across an `RSET`
 * boundary ({@link SmtpConnectionPool.takeConnection} → the client's
 * `resetTransaction` returns the connection to a clean pre-`MAIL` state before
 * the next transaction) instead of opening a fresh TCP+STARTTLS+EHLO handshake
 * every time. Three guardrails bound reuse:
 *   - a per-connection message cap (`maxMessagesPerConnection`, ~100): the
 *     `cap`-th delivery cleanly `QUIT`s the socket so the next job reconnects;
 *   - the max-lifetime cap (`maxAgeMs`, unchanged) applied to the socket's own
 *     open time — an aged socket is `QUIT` rather than reused;
 *   - unhealthy-connection detection: ANY transport error on a send
 *     ({@link SmtpConnectionPool.evictConnection}) tears the entry down and
 *     releases its slot — a poisoned socket is NEVER retried. A failed `RSET`
 *     probe likewise discards the socket and the next job connects fresh.
 * The reuse boundary itself lives in the client's `resetTransaction`, which
 * verifies the 250 so no leftover reply or half-read multiline response leaks
 * between transactions on a reused socket.
 *
 * Distributed coordination (optional, via Redis): each ACTUALLY-CREATED entry
 * holds one global slot (`mta:pool:global:<host>`) that now counts a LIVE socket
 * lineage; the slot is reserved atomically at creation (INCR-then-check, rolled
 * back when over the global cap) and released on every teardown path (per-host
 * evict, idle/aged evict, poisoned-socket evict, closeAll). Reuse of a pooled
 * entry — and a cap-driven QUIT+reconnect within the same entry — takes NO new
 * slot. The cap is best-effort: it fail-opens (no throttle) when Redis is down or
 * coordination is disabled.
 */

import type Redis from 'ioredis';
import {
	quit,
	resetTransaction,
	type SmtpConnectOptions,
	type SmtpConnection,
} from '@owlat/smtp-client';
import { Counter, Gauge } from 'prom-client';
import { registry } from '../monitoring/collector.js';
import { logger } from '../monitoring/logger.js';
import { PoolGlobalCap } from './poolGlobalCap.js';
import {
	buildConnectConfig,
	buildPoolKey,
	type AcquireOptions,
	type TlsKeyProfile,
} from './poolConnectConfig.js';

export type { AcquireOptions, TlsKeyProfile } from './poolConnectConfig.js';

export interface PoolConfig {
	/** Max concurrent entries per host (default 3) */
	maxPerHost: number;
	/** Drop entries idle longer than this (default 30_000ms) */
	idleTimeoutMs: number;
	/** Drop entries older than this regardless of activity (default 300_000ms) */
	maxAgeMs: number;
	/** Max messages over one reused socket before a clean QUIT+reconnect (default 100). */
	maxMessagesPerConnection: number;
}

/** A parked, idle, RSET-reusable live connection cached on a {@link PoolEntry}. */
interface IdleConnection {
	conn: SmtpConnection;
	/** Deliveries already completed over this socket (for the per-connection cap). */
	messagesSent: number;
	/** When the socket was opened (for the max-lifetime cap, reusing `maxAgeMs`). */
	openedAt: number;
}

interface PoolEntry {
	config: SmtpConnectOptions;
	mxHost: string;
	lastUsedAt: number;
	inFlight: number;
	createdAt: number;
	/**
	 * A single idle, live connection parked for the next job to this key, or
	 * undefined when none is currently available (never parked, checked out for an
	 * in-flight send, or torn down). At most one socket is reused per entry;
	 * concurrent sends to the same key open their own one-shot sockets.
	 */
	idle?: IdleConnection;
}

/**
 * Thrown by `acquire` when opening a new connection would exceed the global
 * per-host cap (across all MTA instances). The caller treats it like a transient
 * connection failure — try the next MX, else defer the job for retry.
 */
export class PoolOverCapError extends Error {
	constructor(public readonly mxHost: string) {
		super(`Global connection cap reached for MX host ${mxHost}`);
		this.name = 'PoolOverCapError';
	}
}

// Prometheus gauge for pool connections
export const smtpPoolConnections = new Gauge({
	name: 'mta_smtp_pool_connections',
	help: 'SMTP connection pool size by state',
	labelNames: ['state'] as const,
	registers: [registry],
});

/**
 * Deliveries that reused an already-open pooled socket via RSET rather than
 * opening a fresh TCP+STARTTLS+EHLO handshake (X1). A monotonically rising
 * counter — every successful RSET-boundary reuse increments it exactly once.
 */
export const smtpPoolReused = new Counter({
	name: 'mta_smtp_pool_reused_total',
	help: 'Total SMTP deliveries that reused a live pooled connection via RSET',
	registers: [registry],
});

const DEFAULT_CONFIG: PoolConfig = {
	maxPerHost: 3,
	idleTimeoutMs: 30_000,
	maxAgeMs: 300_000,
	maxMessagesPerConnection: 100,
};

export class SmtpConnectionPool {
	private pool = new Map<string, PoolEntry>();
	private config: PoolConfig;
	private evictionTimer: ReturnType<typeof setInterval> | undefined;
	private cap = new PoolGlobalCap();
	// Message-count + open-time for a connection checked OUT of its entry (between
	// takeConnection and storeConnection), so the caps survive the round-trip
	// without the sender threading them. A WeakMap never pins a dropped socket.
	private connMeta = new WeakMap<SmtpConnection, { messagesSent: number; openedAt: number }>();

	constructor(config?: Partial<PoolConfig>) {
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	/**
	 * Update pool configuration (e.g. after loading env-based config)
	 */
	configure(config: Partial<PoolConfig>): void {
		this.config = { ...this.config, ...config };
	}

	/**
	 * Enable cross-instance connection coordination via Redis.
	 * When enabled, each instance registers its connections in Redis so the
	 * total connections per MX host across all instances stays within the
	 * global limit.
	 */
	enableDistributedCoordination(redis: Redis, globalMaxPerHost: number, serverId: string): void {
		this.cap.enable(redis, globalMaxPerHost, serverId);
	}

	/** Build the pool key for a connection (see {@link buildPoolKey}). */
	static buildKey(
		mxHost: string,
		bindIp: string,
		dkimDomain?: string,
		tls?: TlsKeyProfile
	): string {
		return buildPoolKey(mxHost, bindIp, dkimDomain, tls);
	}

	/**
	 * Acquire a connect config from the pool or build a new one.
	 *
	 * Async because opening a NEW connection consults the Redis global cap when
	 * distributed coordination is enabled. Reusing a pooled config, and the whole
	 * method when coordination is disabled, resolves without a round-trip. The
	 * caller opens ONE {@link SmtpConnection} from the returned config per delivery
	 * attempt (W3 one-connection-per-send) and releases the key afterwards.
	 *
	 * @throws {PoolOverCapError} when a new connection would exceed the global cap.
	 */
	async acquire(
		mxHost: string,
		bindIp: string,
		options: AcquireOptions
	): Promise<{ key: string; config: SmtpConnectOptions }> {
		if (options.tls?.verifyPeerCertificate && !options.tls.danePolicyFingerprint) {
			throw new Error('DANE verifier requires a policy fingerprint for safe pooling');
		}
		const dkimDomain = options.dkimDomain;
		const key = buildPoolKey(mxHost, bindIp, dkimDomain, {
			requireTLS: options.requireTLS,
			rejectUnauthorized: options.tls?.rejectUnauthorized,
			danePolicyFingerprint: options.tls?.danePolicyFingerprint,
		});

		// Reuse fast-path — an already-counted config, no new global slot.
		const existing = this.pool.get(key);
		if (existing) {
			existing.inFlight++;
			existing.lastUsedAt = Date.now();
			this.updateGauge();
			return { key, config: existing.config };
		}

		// Per-host limit (this instance): evict the LRU idle entry to make room.
		const hostPrefix = `${mxHost}:`;
		let hostCount = 0;
		for (const poolKey of this.pool.keys()) {
			if (poolKey.startsWith(hostPrefix)) {
				hostCount++;
			}
		}

		if (hostCount >= this.config.maxPerHost) {
			let oldestKey: string | undefined;
			let oldestTime = Infinity;
			for (const [poolKey, entry] of this.pool.entries()) {
				if (
					poolKey.startsWith(hostPrefix) &&
					entry.inFlight === 0 &&
					entry.lastUsedAt < oldestTime
				) {
					oldestTime = entry.lastUsedAt;
					oldestKey = poolKey;
				}
			}
			if (oldestKey) {
				const evicted = this.pool.get(oldestKey);
				if (evicted) {
					this.disposeIdle(evicted);
				}
				this.pool.delete(oldestKey);
				this.cap.release(mxHost);
				logger.debug({ key: oldestKey }, 'Evicted pool entry for host limit');
			}
		}

		// Global cap (across all instances): atomically reserve a slot for the new
		// entry. Throws when over cap so the caller can defer the job.
		if (!(await this.cap.tryReserve(mxHost, this.slotTtlSeconds()))) {
			throw new PoolOverCapError(mxHost);
		}

		const config = buildConnectConfig(mxHost, bindIp, options);

		const entry: PoolEntry = {
			config,
			mxHost,
			lastUsedAt: Date.now(),
			inFlight: 1,
			createdAt: Date.now(),
		};

		this.pool.set(key, entry);
		this.updateGauge();
		logger.debug({ key }, 'Created new pool entry');

		return { key, config };
	}

	/**
	 * Get the global connection count for an MX host (across all instances).
	 * Fail-open to 0. Exposed for monitoring/tests.
	 */
	getGlobalConnectionCount(mxHost: string): Promise<number> {
		return this.cap.getCount(mxHost);
	}

	/**
	 * Release an entry back to the pool after use. In-memory only — the global
	 * slot is held for the entry's whole lifetime and released on teardown.
	 */
	release(key: string): void {
		const entry = this.pool.get(key);
		if (!entry) return;

		entry.inFlight = Math.max(0, entry.inFlight - 1);
		entry.lastUsedAt = Date.now();
		this.updateGauge();
	}

	// ── Live-socket reuse (X1) ──

	/**
	 * Check out a live, RSET-cleaned connection to reuse for the next delivery to
	 * `key`, or `undefined` when the caller must open a fresh {@link SmtpConnection}
	 * from the entry's config. Returns `undefined` (cleanly tearing the parked
	 * socket down where needed) when: no socket is parked; the parked socket is over
	 * the per-connection message cap or past its max lifetime (cleanly `QUIT`); or
	 * its `RSET` reuse probe fails (poisoned — discarded). A returned connection has
	 * passed the `RSET` boundary, so no state leaks from the prior transaction, and
	 * the reuse counter has been incremented. The global slot is retained across all
	 * of these — a reconnect on the SAME entry takes no new slot.
	 */
	async takeConnection(key: string): Promise<SmtpConnection | undefined> {
		const entry = this.pool.get(key);
		if (!entry || !entry.idle) {
			return undefined;
		}
		const idle = entry.idle;
		entry.idle = undefined; // check out — an in-flight send parks nothing meanwhile
		this.updateGauge();

		const now = Date.now();
		const overCap = idle.messagesSent >= this.config.maxMessagesPerConnection;
		const aged = now - idle.openedAt > this.config.maxAgeMs;
		if (overCap || aged) {
			// Bounded socket: retire it cleanly so the caller reconnects fresh.
			this.quitConnection(idle.conn);
			return undefined;
		}

		try {
			// The RSET boundary: verified 250 → clean pre-MAIL state, no leftover
			// reply or half-read multiline response from the prior transaction.
			await resetTransaction(idle.conn);
		} catch {
			// A poisoned socket (dead peer, unexpected reply): discard, reconnect fresh.
			idle.conn.close();
			return undefined;
		}
		// Carry the caps across the send so storeConnection can apply them on return.
		this.connMeta.set(idle.conn, { messagesSent: idle.messagesSent, openedAt: idle.openedAt });
		smtpPoolReused.inc();
		return idle.conn;
	}

	/**
	 * Return a healthy connection after a SUCCESSFUL delivery. Parks it on its entry
	 * for the next job to reuse, or cleanly `QUIT`s it when it has hit the
	 * per-connection message cap or its max lifetime (the next job then reconnects),
	 * when its entry is gone (evicted underneath it), or when the entry already has a
	 * parked socket (a concurrent send won the slot). Only ever call this for a
	 * connection whose transaction completed cleanly — a failed send goes to
	 * {@link evictConnection}.
	 */
	storeConnection(key: string, conn: SmtpConnection): void {
		const meta = this.connMeta.get(conn) ?? { messagesSent: 0, openedAt: Date.now() };
		this.connMeta.delete(conn);
		const messagesSent = meta.messagesSent + 1;
		const now = Date.now();

		const entry = this.pool.get(key);
		const overCap = messagesSent >= this.config.maxMessagesPerConnection;
		const aged = now - meta.openedAt > this.config.maxAgeMs;
		if (!entry || entry.idle || overCap || aged) {
			this.quitConnection(conn);
			return;
		}
		entry.idle = { conn, messagesSent, openedAt: meta.openedAt };
		entry.lastUsedAt = now;
		this.updateGauge();
	}

	/**
	 * Tear down a poisoned connection after a transport/protocol error mid-delivery
	 * and evict its whole entry, releasing the global slot. A socket that errored
	 * once is NEVER reused; the in-flight job retries on a fresh connection (next MX
	 * or a requeue) exactly once. Idempotent with respect to a missing entry.
	 */
	evictConnection(key: string, conn: SmtpConnection): void {
		conn.close();
		this.connMeta.delete(conn);
		const entry = this.pool.get(key);
		if (!entry) {
			return;
		}
		if (entry.idle) {
			// Defensive: a concurrently-parked socket on a now-poisoned entry goes too.
			entry.idle.conn.close();
			entry.idle = undefined;
		}
		this.pool.delete(key);
		this.cap.release(entry.mxHost);
		this.updateGauge();
		logger.debug({ key }, 'Evicted pool entry after a transport error');
	}

	/** Best-effort polite teardown: send QUIT, read the 221, then destroy. */
	private quitConnection(conn: SmtpConnection): void {
		void quit(conn).catch(() => {});
	}

	/** Cleanly retire an entry's parked idle socket, if any, before it is dropped. */
	private disposeIdle(entry: PoolEntry): void {
		if (entry.idle) {
			this.quitConnection(entry.idle.conn);
			entry.idle = undefined;
		}
	}

	/**
	 * Start periodic eviction of idle and aged-out entries
	 */
	startEviction(intervalMs = 10_000): void {
		if (this.evictionTimer) return;

		this.evictionTimer = setInterval(() => {
			const now = Date.now();
			const keysToEvict: string[] = [];

			for (const [key, entry] of this.pool.entries()) {
				const idle = entry.inFlight === 0 && now - entry.lastUsedAt > this.config.idleTimeoutMs;
				const aged = now - entry.createdAt > this.config.maxAgeMs && entry.inFlight === 0;

				if (idle || aged) {
					keysToEvict.push(key);
				}
			}

			for (const key of keysToEvict) {
				const entry = this.pool.get(key)!;
				this.disposeIdle(entry);
				this.pool.delete(key);
				this.cap.release(entry.mxHost);
				logger.debug({ key }, 'Evicted idle/aged pool entry');
			}

			if (keysToEvict.length > 0) {
				this.updateGauge();
			}
		}, intervalMs);
	}

	/**
	 * Close the pool, waiting for in-flight sends to complete
	 */
	async closeAll(drainTimeoutMs = 10_000): Promise<void> {
		// Stop eviction
		if (this.evictionTimer) {
			clearInterval(this.evictionTimer);
			this.evictionTimer = undefined;
		}

		// Wait for in-flight to reach 0
		const deadline = Date.now() + drainTimeoutMs;
		while (Date.now() < deadline) {
			let totalInFlight = 0;
			for (const entry of this.pool.values()) {
				totalInFlight += entry.inFlight;
			}
			if (totalInFlight === 0) break;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		// Drop all entries, closing any parked live socket and releasing each one's
		// global slot.
		for (const entry of this.pool.values()) {
			this.disposeIdle(entry);
			this.cap.release(entry.mxHost);
		}

		this.pool.clear();
		this.updateGauge();
		logger.info('SMTP connection pool closed');
	}

	/**
	 * Current pool size (for testing/monitoring)
	 */
	get size(): number {
		return this.pool.size;
	}

	private updateGauge(): void {
		let idle = 0;
		let active = 0;
		for (const entry of this.pool.values()) {
			if (entry.inFlight > 0) {
				active++;
			} else {
				idle++;
			}
		}
		smtpPoolConnections.set({ state: 'idle' }, idle);
		smtpPoolConnections.set({ state: 'active' }, active);
	}

	/**
	 * TTL for the global/instance counters — must outlive an entry's max age so a
	 * live connection's slot never expires out from under it. The decrement on
	 * teardown is the real cleanup; the TTL is only a crashed-instance backstop.
	 */
	private slotTtlSeconds(): number {
		return Math.ceil(this.config.maxAgeMs / 1000) + 60;
	}
}

/** Singleton pool instance */
export const pool = new SmtpConnectionPool();
