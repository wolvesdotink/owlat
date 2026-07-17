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
 * One-connection-per-send is preserved (locked decision W3): a pool entry holds
 * only the resolved connect config — never a live socket — because the sender
 * opens a FRESH {@link SmtpConnection} per delivery attempt and tears it down
 * afterwards. Live-socket reuse (true RSET pipelining) is a later capability
 * (X1), NOT this pool. The entry therefore exists purely to (a) partition the
 * global connection-cap accounting by mx/bindIp/dkim/tls-profile and (b) keep
 * one-connection-per-send politeness bounded per MX.
 *
 * Distributed coordination (optional, via Redis): each ACTUALLY-CREATED entry
 * holds one global slot (`mta:pool:global:<host>`); the slot is reserved
 * atomically at creation (INCR-then-check, rolled back when over the global cap)
 * and released on every teardown path (per-host evict, idle/aged evict, closeAll).
 * Reuse of a pooled entry takes NO new slot. The cap is best-effort: it
 * fail-opens (no throttle) when Redis is down or coordination is disabled.
 */

import type { TLSSocket } from 'node:tls';
import type Redis from 'ioredis';
import type { SmtpConnectOptions } from '@owlat/smtp-client';
import { Gauge } from 'prom-client';
import { registry } from '../monitoring/collector.js';
import { logger } from '../monitoring/logger.js';

export interface PoolConfig {
	/** Max concurrent entries per host (default 3) */
	maxPerHost: number;
	/** Drop entries idle longer than this (default 30_000ms) */
	idleTimeoutMs: number;
	/** Drop entries older than this regardless of activity (default 300_000ms) */
	maxAgeMs: number;
}

export interface AcquireOptions {
	port?: number;
	requireTLS?: boolean;
	tls?: {
		rejectUnauthorized?: boolean;
		minVersion?: 'TLSv1.2' | 'TLSv1.3';
		/**
		 * RFC 6066 §3 Server Name Indication. Offered in the TLS ClientHello so a
		 * shared-hosting MX can select the right certificate. Forwarded verbatim to
		 * the client's TLS options; when omitted the client defaults it to `host`.
		 */
		servername?: string;
		/**
		 * Runs after STARTTLS succeeds but before SMTP resumes. It runs even with
		 * PKIX rejection disabled (DANE-EE), and any returned error destroys the
		 * socket before the post-TLS EHLO.
		 */
		verifyPeerCertificate?: (socket: TLSSocket) => Error | undefined;
		/** Pool-only identity for the exact TLSA RRset and DANE-TA reference names. */
		danePolicyFingerprint?: string;
	};
	/** The EHLO/HELO name announced to the MX (the sending MTA identity). */
	name?: string;
	connectionTimeout?: number;
	greetingTimeout?: number;
	socketTimeout?: number;
	/** The DKIM sending domain — a KEY PARTITIONING DIMENSION ONLY (signing is sign-time). */
	dkimDomain?: string;
}

interface PoolEntry {
	config: SmtpConnectOptions;
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
	 * The TLS profile (requireTLS + rejectUnauthorized + DANE policy) is part of
	 * the key so a verifying/enforcing connection is NEVER served an
	 * opportunistic, non-verifying entry to the same shared MX. Defaults match
	 * the config-factory defaults (requireTLS=false, rejectUnauthorized=false)
	 * so callers that omit the profile get the opportunistic bucket — the existing
	 * behaviour.
	 */
	static buildKey(
		mxHost: string,
		bindIp: string,
		dkimDomain?: string,
		tls?: {
			requireTLS?: boolean;
			rejectUnauthorized?: boolean;
			danePolicyFingerprint?: string;
		}
	): string {
		const requireTLS = tls?.requireTLS ?? false;
		const rejectUnauthorized = tls?.rejectUnauthorized ?? false;
		// A DANE entry must not outlive or cross recipient-specific TLSA policy.
		// The exact RRset + reference-name fingerprint therefore participates in
		// identity; non-DANE keys remain unchanged.
		const daneSuffix = tls?.danePolicyFingerprint ? `da${tls.danePolicyFingerprint}` : '';
		const tlsProfile = `rt${requireTLS ? 1 : 0}ru${rejectUnauthorized ? 1 : 0}${daneSuffix}`;
		return `${mxHost}:${bindIp}:${dkimDomain ?? 'none'}:${tlsProfile}`;
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
		const key = SmtpConnectionPool.buildKey(mxHost, bindIp, dkimDomain, {
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
				this.pool.delete(oldestKey);
				this.releaseGlobalSlot(mxHost);
				logger.debug({ key: oldestKey }, 'Evicted pool entry for host limit');
			}
		}

		// Global cap (across all instances): atomically reserve a slot for the new
		// entry. Throws when over cap so the caller can defer the job.
		if (!(await this.tryReserveGlobalSlot(mxHost))) {
			throw new PoolOverCapError(mxHost);
		}

		const config = SmtpConnectionPool.buildConnectConfig(mxHost, bindIp, options);

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
	 * Assemble the @owlat/smtp-client connect config for one MX/bindIp/profile.
	 *
	 * Outbound MX delivery is always STARTTLS on port 25 (opportunistic upgrade,
	 * escalated to a required floor by `requireTLS`). The TLSv1.2 floor is pinned
	 * here (RFC 8996/9325) so it never rests on Node's env-fragile process default;
	 * the caller may raise it to TLSv1.3 but cannot lower it. `danePolicyFingerprint`
	 * is pool-only identity and is deliberately NOT forwarded to the client.
	 */
	static buildConnectConfig(
		mxHost: string,
		bindIp: string,
		options: AcquireOptions
	): SmtpConnectOptions {
		const tls: SmtpConnectOptions['tls'] = {
			// nosemgrep -- opportunistic TLS default for SMTP delivery (RFC 7435); callers (MTA-STS enforce) override via options.tls.
			rejectUnauthorized: options.tls?.rejectUnauthorized ?? false,
			minVersion: options.tls?.minVersion ?? 'TLSv1.2',
		};
		if (options.tls?.servername !== undefined) {
			tls.servername = options.tls.servername;
		}
		if (options.tls?.verifyPeerCertificate !== undefined) {
			tls.verifyPeerCertificate = options.tls.verifyPeerCertificate;
		}
		const config: SmtpConnectOptions = {
			host: mxHost,
			port: options.port ?? 25,
			// Production always supplies `name` (the sending IP's PTR-matching FQDN).
			// The fallback must never announce the RECEIVING server's hostname
			// (`mxHost`) — that is our identity to the peer and would read as spoofing
			// (RFC 5321 §4.1.1.1). Fall back to our own bind IP as an address literal
			// (RFC 5321 §4.1.3), which is honest and syntactically valid.
			ehloName: options.name ?? `[${bindIp}]`,
			tlsMode: 'starttls',
			requireTls: options.requireTLS ?? false,
			localAddress: bindIp,
			tls,
			timeouts: {
				connect: options.connectionTimeout ?? 30_000,
				greeting: options.greetingTimeout ?? 30_000,
				command: options.socketTimeout ?? 60_000,
			},
		};
		return config;
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

		// Drop all entries, releasing each one's global slot.
		for (const entry of this.pool.values()) {
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

	/** TTL for the global/instance counters — must outlive an entry's max age
	 * so a live connection's slot never expires out from under it. The decrement
	 * on teardown is the real cleanup; the TTL is only a crashed-instance backstop. */
	private slotTtlSeconds(): number {
		return Math.ceil(this.config.maxAgeMs / 1000) + 60;
	}

	/**
	 * Atomically reserve one global slot for a NEW entry to `mxHost`. INCR is
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
	 * Release one global slot held by a torn-down entry. Fire-and-forget;
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
