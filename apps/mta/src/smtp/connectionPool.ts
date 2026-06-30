/**
 * SMTP Connection Pool
 *
 * Maintains reusable nodemailer transports keyed by
 * {mxHost}:{bindIp}:{dkimDomain}:{tlsProfile}, where tlsProfile encodes
 * requireTLS + tls.rejectUnauthorized. The TLS profile MUST be part of the key:
 * many domains share an MX (Google/O365), so without it an MTA-STS-enforce send
 * (requireTLS + verifying) would silently reuse an earlier opportunistic,
 * non-verifying transport to the same MX — a STARTTLS-stripping / enforcement
 * bypass on exactly the high-value shared-MX providers (RFC 8461 §5, RFC 7435).
 * Evicts idle and aged-out connections automatically.
 *
 * Distributed coordination (optional, via Redis): each ACTUALLY-CREATED transport
 * holds one global slot (`mta:pool:global:<host>`); the slot is reserved
 * atomically at creation (INCR-then-check, rolled back when over the global cap)
 * and released on every teardown path (per-host evict, idle/aged evict, closeAll).
 * Reuse of a pooled transport takes NO new slot. The cap is best-effort: it
 * fail-opens (no throttle) when Redis is down or coordination is disabled.
 */

import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type Redis from 'ioredis';
import { Gauge } from 'prom-client';
import { registry } from '../monitoring/collector.js';
import { logger } from '../monitoring/logger.js';
import { makeDkimProcessFunc } from './dkim.js';
import { securedCaptureLogger } from './tlsSecuredCapture.js';

export interface PoolConfig {
	/** Max concurrent transports per host (default 3) */
	maxPerHost: number;
	/** Close transports idle longer than this (default 30_000ms) */
	idleTimeoutMs: number;
	/** Close transports older than this regardless of activity (default 300_000ms) */
	maxAgeMs: number;
}

export interface AcquireOptions {
	port?: number;
	secure?: boolean;
	requireTLS?: boolean;
	tls?: {
		rejectUnauthorized?: boolean;
		minVersion?: 'TLSv1.2' | 'TLSv1.3';
		/**
		 * RFC 6066 §3 Server Name Indication. Offered in the TLS ClientHello so a
		 * shared-hosting MX can select the right certificate. nodemailer defaults
		 * it to the connection `host`; the pool forwards an explicit override
		 * verbatim. Forwarded into the transport via the `...options.tls` spread.
		 */
		servername?: string;
	};
	name?: string;
	connectionTimeout?: number;
	greetingTimeout?: number;
	socketTimeout?: number;
	dkim?: { domainName: string; keySelector: string; privateKey: string };
}

interface PoolEntry {
	transport: Transporter;
	mxHost: string;
	lastUsedAt: number;
	inFlight: number;
	createdAt: number;
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

const DEFAULT_CONFIG: PoolConfig = {
	maxPerHost: 3,
	idleTimeoutMs: 30_000,
	maxAgeMs: 300_000,
};

export class SmtpConnectionPool {
	private pool = new Map<string, PoolEntry>();
	private config: PoolConfig;
	private evictionTimer: ReturnType<typeof setInterval> | undefined;
	private redis?: Redis;
	private globalMaxPerHost?: number;
	private serverId?: string;

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
		this.redis = redis;
		this.globalMaxPerHost = globalMaxPerHost;
		this.serverId = serverId;
	}

	/**
	 * Build the pool key for a given connection.
	 *
	 * The TLS profile (requireTLS + rejectUnauthorized) is part of the key so a
	 * verifying/enforcing connection is NEVER served an opportunistic,
	 * non-verifying transport to the same shared MX. Defaults match the transport
	 * factory defaults (requireTLS=false, rejectUnauthorized=false) so callers
	 * that omit the profile get the opportunistic bucket — the existing behaviour.
	 */
	static buildKey(
		mxHost: string,
		bindIp: string,
		dkimDomain?: string,
		tls?: { requireTLS?: boolean; rejectUnauthorized?: boolean },
	): string {
		const requireTLS = tls?.requireTLS ?? false;
		const rejectUnauthorized = tls?.rejectUnauthorized ?? false;
		const tlsProfile = `rt${requireTLS ? 1 : 0}ru${rejectUnauthorized ? 1 : 0}`;
		return `${mxHost}:${bindIp}:${dkimDomain ?? 'none'}:${tlsProfile}`;
	}

	/**
	 * Acquire a transport from the pool or create a new one.
	 *
	 * Async because opening a NEW connection consults the Redis global cap when
	 * distributed coordination is enabled. Reusing a pooled transport, and the
	 * whole method when coordination is disabled, resolves without a round-trip.
	 *
	 * @throws {PoolOverCapError} when a new connection would exceed the global cap.
	 */
	async acquire(
		mxHost: string,
		bindIp: string,
		options: AcquireOptions,
	): Promise<{ key: string; transport: Transporter }> {
		const dkimDomain = options.dkim?.domainName;
		const key = SmtpConnectionPool.buildKey(mxHost, bindIp, dkimDomain, {
			requireTLS: options.requireTLS,
			rejectUnauthorized: options.tls?.rejectUnauthorized,
		});

		// Reuse fast-path — an already-counted transport, no new global slot.
		const existing = this.pool.get(key);
		if (existing) {
			existing.inFlight++;
			existing.lastUsedAt = Date.now();
			this.updateGauge();
			return { key, transport: existing.transport };
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
				if (poolKey.startsWith(hostPrefix) && entry.inFlight === 0 && entry.lastUsedAt < oldestTime) {
					oldestTime = entry.lastUsedAt;
					oldestKey = poolKey;
				}
			}
			if (oldestKey) {
				const evicted = this.pool.get(oldestKey)!;
				evicted.transport.close();
				this.pool.delete(oldestKey);
				this.releaseGlobalSlot(mxHost);
				logger.debug({ key: oldestKey }, 'Evicted pool entry for host limit');
			}
		}

		// Global cap (across all instances): atomically reserve a slot for the new
		// transport. Throws when over cap so the caller can defer the job.
		if (!(await this.tryReserveGlobalSlot(mxHost))) {
			throw new PoolOverCapError(mxHost);
		}

		const transport = nodemailer.createTransport({
			host: mxHost,
			port: options.port ?? 25,
			secure: options.secure ?? false,
			requireTLS: options.requireTLS ?? false,
			// Pin a TLSv1.2 floor on every outbound STARTTLS connection. Without an
			// explicit minVersion the floor is Node's process default, which is
			// env-fragile (NODE_OPTIONS=--tls-min-v1.0, or a future Node default
			// shift) and could silently negotiate down to TLS 1.0/1.1. RFC 8996
			// deprecates those; RFC 9325 mandates TLS 1.2+. The caller may raise the
			// floor to TLSv1.3 but cannot lower it below 1.2.
			tls: { rejectUnauthorized: false, ...options.tls, minVersion: options.tls?.minVersion ?? 'TLSv1.2' },
			name: options.name,
			localAddress: bindIp,
			connectionTimeout: options.connectionTimeout ?? 30_000,
			greetingTimeout: options.greetingTimeout ?? 30_000,
			socketTimeout: options.socketTimeout ?? 60_000,
			// Attach a logger that records, per send, whether the connection
			// negotiated TLS (it watches for nodemailer's "Connection upgraded with
			// STARTTLS" line). nodemailer exposes no secured flag on `info`, so this
			// is how the sender distinguishes an encrypted delivery from a plaintext
			// one and records the right TLS-RPT result type (RFC 8460) instead of
			// logging every successful send as a TLS 'success'. See tlsSecuredCapture.ts.
			logger: securedCaptureLogger,
			// NOTE: nodemailer's built-in `dkim` transport option is deliberately NOT
			// passed. Its signer cannot oversign (it de-dups `h=`) or emit `t=`. We
			// sign through a `stream` plugin (below) using our hardened signer so the
			// pool key still partitions transports by dkim domain via `options.dkim`.
		});

		// Wire the hardened DKIM signer (oversign From/Subject/To + `t=`). The
		// transport in this pool is dedicated to one dkim domain (the pool key
		// includes `dkimDomain`), so binding the key here is safe. Guarded for the
		// `.use` method so test doubles that stub `createTransport` aren't required
		// to implement the plugin API.
		if (options.dkim && typeof (transport as { use?: unknown }).use === 'function') {
			const dkimKey = {
				domainName: options.dkim.domainName,
				keySelector: options.dkim.keySelector,
				privateKey: options.dkim.privateKey,
			};
			(transport as unknown as {
				use(step: string, plugin: (mail: { message?: { processFunc(fn: (input: NodeJS.ReadableStream) => NodeJS.ReadableStream): void } }, done: (err?: Error) => void) => void): void;
			}).use('stream', (mail, done) => {
				mail.message?.processFunc(makeDkimProcessFunc(dkimKey));
				done();
			});
		}

		const entry: PoolEntry = {
			transport,
			mxHost,
			lastUsedAt: Date.now(),
			inFlight: 1,
			createdAt: Date.now(),
		};

		this.pool.set(key, entry);
		this.updateGauge();
		logger.debug({ key }, 'Created new pool entry');

		return { key, transport };
	}

	/**
	 * Get the global connection count for an MX host (across all instances).
	 * Fail-open to 0. Exposed for monitoring/tests.
	 */
	async getGlobalConnectionCount(mxHost: string): Promise<number> {
		if (!this.redis) return 0;
		try {
			const globalKey = `mta:pool:global:${mxHost}`;
			const count = await this.redis.get(globalKey);
			return count ? parseInt(count, 10) : 0;
		} catch {
			return 0;
		}
	}

	/**
	 * Release a transport back to the pool after use. In-memory only — the global
	 * slot is held for the transport's whole lifetime and released on teardown.
	 */
	release(key: string): void {
		const entry = this.pool.get(key);
		if (!entry) return;

		entry.inFlight = Math.max(0, entry.inFlight - 1);
		entry.lastUsedAt = Date.now();
		this.updateGauge();
	}

	/**
	 * Start periodic eviction of idle and aged-out transports
	 */
	startEviction(intervalMs = 10_000): void {
		if (this.evictionTimer) return;

		this.evictionTimer = setInterval(() => {
			const now = Date.now();
			const keysToEvict: string[] = [];

			for (const [key, entry] of this.pool.entries()) {
				const idle = entry.inFlight === 0 && (now - entry.lastUsedAt) > this.config.idleTimeoutMs;
				const aged = (now - entry.createdAt) > this.config.maxAgeMs && entry.inFlight === 0;

				if (idle || aged) {
					keysToEvict.push(key);
				}
			}

			for (const key of keysToEvict) {
				const entry = this.pool.get(key)!;
				entry.transport.close();
				this.pool.delete(key);
				this.releaseGlobalSlot(entry.mxHost);
				logger.debug({ key }, 'Evicted idle/aged pool entry');
			}

			if (keysToEvict.length > 0) {
				this.updateGauge();
			}
		}, intervalMs);
	}

	/**
	 * Close all transports, waiting for in-flight sends to complete
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

		// Close all transports, releasing each one's global slot.
		for (const [key, entry] of this.pool.entries()) {
			try {
				entry.transport.close();
			} catch {
				logger.warn({ key }, 'Error closing pooled transport');
			}
			this.releaseGlobalSlot(entry.mxHost);
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

	// ── Distributed Coordination Helpers ──

	/** TTL for the global/instance counters — must outlive a transport's max age
	 * so a live connection's slot never expires out from under it. The decrement
	 * on teardown is the real cleanup; the TTL is only a crashed-instance backstop. */
	private slotTtlSeconds(): number {
		return Math.ceil(this.config.maxAgeMs / 1000) + 60;
	}

	/**
	 * Atomically reserve one global slot for a NEW transport to `mxHost`. INCR is
	 * atomic, so concurrent reservers get distinct counts and only those within
	 * the cap keep their slot; an over-cap reserver rolls its INCR back. Returns
	 * true (allow, no tracking) when coordination is disabled, and fail-OPEN
	 * (true) on any Redis error so an outage degrades to per-host-only limiting.
	 */
	private async tryReserveGlobalSlot(mxHost: string): Promise<boolean> {
		if (!this.redis || !this.serverId || !this.globalMaxPerHost) return true;

		const globalKey = `mta:pool:global:${mxHost}`;
		const instanceKey = `mta:pool:instance:${this.serverId}:${mxHost}`;
		const ttl = this.slotTtlSeconds();

		try {
			const count = await this.redis.incr(globalKey);
			await this.redis.expire(globalKey, ttl);
			if (count > this.globalMaxPerHost) {
				await this.redis.decr(globalKey); // over cap — give the slot back
				return false;
			}
			await this.redis.incr(instanceKey);
			await this.redis.expire(instanceKey, ttl);
			return true;
		} catch {
			return true; // fail open
		}
	}

	/**
	 * Release one global slot held by a torn-down transport. Fire-and-forget;
	 * paired 1:1 with a successful tryReserveGlobalSlot. The TTL backstops any
	 * decr that is lost (e.g. instance crash).
	 */
	private releaseGlobalSlot(mxHost: string): void {
		if (!this.redis || !this.serverId) return;

		const globalKey = `mta:pool:global:${mxHost}`;
		const instanceKey = `mta:pool:instance:${this.serverId}:${mxHost}`;

		this.redis
			.pipeline()
			.decr(globalKey)
			.decr(instanceKey)
			.exec()
			.catch(() => {
				// Non-critical — coordination is best-effort
			});
	}
}

/** Singleton pool instance */
export const pool = new SmtpConnectionPool();
