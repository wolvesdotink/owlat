/**
 * Reusable SMTP socket lineages keyed by MX, bind IP, DKIM domain, and TLS
 * profile. TLS policy is part of the key to prevent cross-domain downgrade on
 * shared MX hosts. Healthy sockets cross a verified RSET boundary before reuse;
 * age/message limits and every transport failure retire the lineage. Each entry
 * owns one Redis-coordinated lease, renewed while the entry remains live.
 */

import type Redis from 'ioredis';
import {
	quit,
	resetTransaction,
	type SmtpConnectOptions,
	type SmtpConnection,
} from '@owlat/smtp-client';
import { logger } from '../monitoring/logger.js';
import { PoolGlobalCap, type PoolCoordinationProtocol } from './poolGlobalCap.js';
import { PoolLeaseHeartbeat, type LeaseHeartbeatTarget } from './poolLeaseHeartbeat.js';
import { smtpPoolConnections, smtpPoolReused } from './poolMetrics.js';
import {
	buildConnectConfig,
	buildPoolKey,
	type AcquireOptions,
	type TlsKeyProfile,
} from './poolConnectConfig.js';
import { PoolOverCapError, type PoolConfig } from './poolLimits.js';
import { DEFAULT_POOL_CONFIG, type PoolEntry } from './poolState.js';

export type { AcquireOptions, TlsKeyProfile } from './poolConnectConfig.js';
export { PoolOverCapError, type PoolConfig } from './poolLimits.js';
export { smtpPoolConnections, smtpPoolReused } from './poolMetrics.js';

/**
 * `PoolOverCapError` is treated like a transient connection failure: try the
 * next MX, then defer when every destination scope is full.
 */
export class SmtpConnectionPool {
	private pool = new Map<string, PoolEntry>();
	private config: PoolConfig;
	private evictionTimer: ReturnType<typeof setInterval> | undefined;
	private coordinationProtocol: PoolCoordinationProtocol = 'leases-v1';
	private cap = new PoolGlobalCap();
	private leaseHeartbeat = new PoolLeaseHeartbeat(
		this.cap,
		() => this.slotTtlSeconds(),
		() => [...this.pool.entries()].map(([key, entry]) => ({ key, lease: entry.globalLease })),
		(target) => this.handleLeaseLoss(target)
	);
	private entrySequence = 0;
	// Message-count + open-time for a connection checked OUT of its entry (between
	// takeConnection and storeConnection), so the caps survive the round-trip without
	// the sender threading them. A WeakMap never pins a dropped socket.
	private connMeta = new WeakMap<SmtpConnection, { messagesSent: number; openedAt: number }>();

	constructor(config?: Partial<PoolConfig>) {
		this.config = { ...DEFAULT_POOL_CONFIG, ...config };
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
	enableDistributedCoordination(
		redis: Redis,
		globalMaxPerHost: number,
		serverId: string,
		protocol: PoolCoordinationProtocol = 'leases-v1'
	): void {
		this.coordinationProtocol = protocol;
		this.cap.enable(redis, globalMaxPerHost, serverId, protocol);
		this.leaseHeartbeat.start(protocol);
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

	/** Reserve a pool entry, throwing PoolOverCapError when its scope is full. */
	async acquire(
		mxHost: string,
		bindIp: string,
		options: AcquireOptions
	): Promise<{ key: string; config: SmtpConnectOptions }> {
		if (options.tls?.verifyPeerCertificate && !options.tls.danePolicyFingerprint) {
			throw new Error('DANE verifier requires a policy fingerprint for safe pooling');
		}
		const dkimDomain = options.dkimDomain;
		const baseKey = buildPoolKey(mxHost, bindIp, dkimDomain, {
			requireTLS: options.requireTLS,
			rejectUnauthorized: options.tls?.rejectUnauthorized,
			danePolicyFingerprint: options.tls?.danePolicyFingerprint,
		});

		// Reuse fast-path — an already-counted config, no new global slot.
		const existingMatch = [...this.pool.entries()].find(
			([, entry]) => entry.baseKey === baseKey && entry.inFlight === 0
		);
		const existing = existingMatch?.[1];
		if (existing) {
			existing.inFlight = 1;
			existing.lastUsedAt = Date.now();
			existing.maxDeliveriesPerConnection =
				options.connectionLimits?.maxDeliveriesPerConnection ?? existing.maxDeliveriesPerConnection;
			this.updateGauge();
			return { key: existingMatch![0], config: existing.config };
		}

		const connectionScope = options.connectionLimits?.scope ?? mxHost;
		const maxConnections = options.connectionLimits?.maxConnections ?? this.config.maxPerHost;
		const strictProviderLimit = options.connectionLimits !== undefined;

		// Per-scope limit (provider for known shared receivers, MX otherwise):
		// evict the LRU idle lineage to make room, never an in-flight connection.
		let scopeEntryCount = [...this.pool.values()].filter(
			(entry) => entry.connectionScope === connectionScope
		).length;
		while (scopeEntryCount >= maxConnections) {
			let oldestKey: string | undefined;
			let oldestTime = Infinity;
			for (const [poolKey, entry] of this.pool.entries()) {
				if (
					entry.connectionScope === connectionScope &&
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
				this.cap.release(evicted!.globalLease);
				logger.debug({ key: oldestKey }, 'Evicted pool entry for connection-scope limit');
				scopeEntryCount--;
			}
			if (!oldestKey) {
				if (strictProviderLimit) throw new PoolOverCapError(connectionScope);
				break;
			}
		}

		// Global cap (across all instances): atomically reserve a slot for the new
		// entry. Throws when over cap so the caller can defer the job.
		const matchingConfig = [...this.pool.values()].find(
			(entry) => entry.baseKey === baseKey
		)?.config;
		const config = matchingConfig ?? buildConnectConfig(mxHost, bindIp, options);
		// legacy-v0 must use the exact per-MX scalar key understood by binaries
		// currently on main. Provider-wide lease scopes activate only after the
		// explicitly gated leases-v1 fleet cutover.
		const globalConnectionScope =
			this.coordinationProtocol === 'legacy-v0' ? mxHost : connectionScope;
		const globalLease = await this.cap.tryReserve(
			globalConnectionScope,
			this.slotTtlSeconds(),
			this.coordinationProtocol === 'legacy-v0'
				? undefined
				: options.connectionLimits?.maxConnections
		);
		if (!globalLease) {
			throw new PoolOverCapError(connectionScope);
		}

		const key = this.pool.has(baseKey) ? `${baseKey}#${++this.entrySequence}` : baseKey;
		const entry: PoolEntry = {
			baseKey,
			config,
			connectionScope,
			globalLease,
			maxDeliveriesPerConnection:
				options.connectionLimits?.maxDeliveriesPerConnection ??
				this.config.maxMessagesPerConnection,
			lastUsedAt: Date.now(),
			inFlight: 1,
			createdAt: Date.now(),
		};

		this.pool.set(key, entry);
		this.updateGauge();
		logger.debug({ key }, 'Created new pool entry');

		return { key, config };
	}

	/** Observed global count; monitoring returns 0 on Redis errors. */
	getGlobalConnectionCount(connectionScope: string): Promise<number> {
		return this.cap.getCount(connectionScope);
	}

	/** Mark an entry idle while retaining its global slot for reuse. */
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
	 * from the entry's config — cleanly tearing the parked socket down where needed:
	 * no socket is parked; it is {@link isRetirable} (over the message cap / past its
	 * lifetime, `QUIT`); or its `RSET` probe fails (poisoned — discarded). A returned
	 * connection passed the `RSET` boundary (no state leaks) and bumped the reuse
	 * counter. The global slot is retained across all of these — a reconnect on the
	 * SAME entry takes no new slot.
	 */
	async takeConnection(key: string): Promise<SmtpConnection | undefined> {
		const entry = this.pool.get(key);
		if (!entry || !entry.idle) {
			return undefined;
		}
		const idle = entry.idle;
		entry.idle = undefined; // check out — an in-flight send parks nothing meanwhile
		entry.active = idle.conn;
		this.updateGauge();

		if (this.isRetirable(idle.messagesSent, idle.openedAt, entry.maxDeliveriesPerConnection)) {
			// Aged out while parked (the message cap is enforced before parking in
			// storeConnection, so only the lifetime bound trips here): retire it cleanly.
			this.quitConnection(idle.conn);
			entry.active = undefined;
			return undefined;
		}

		try {
			// The RSET boundary: verified 250 → clean pre-MAIL state, no leftover
			// reply or half-read multiline response from the prior transaction.
			await resetTransaction(idle.conn);
		} catch {
			// A poisoned socket (dead peer, unexpected reply): discard, reconnect fresh.
			idle.conn.close();
			entry.active = undefined;
			return undefined;
		}
		// Carry the caps across the send so storeConnection can apply them on return.
		this.connMeta.set(idle.conn, { messagesSent: idle.messagesSent, openedAt: idle.openedAt });
		smtpPoolReused.inc();
		return idle.conn;
	}

	/** Attach a freshly opened socket so lease loss can fence the active attempt. */
	attachConnection(key: string, conn: SmtpConnection): boolean {
		const entry = this.pool.get(key);
		if (!entry) {
			conn.close();
			return false;
		}
		entry.active = conn;
		return true;
	}

	/**
	 * Return a PROTOCOL-HEALTHY connection to its entry: parks it for reuse, or cleanly
	 * `QUIT`s it when {@link isRetirable}, when its entry is gone, or when the entry
	 * already parks a socket (a concurrent send won the slot). Call this for a socket
	 * whose transaction completed cleanly OR that suffered a clean pre-DATA reply
	 * rejection (a bounced MAIL/RCPT that left the SMTP session open, not a 421 channel
	 * close) — the next job's RSET boundary aborts the leftover transaction before
	 * reuse. A poisoned socket (transport/TLS fault, or DATA-phase ambiguity) goes to
	 * {@link evictConnection} instead.
	 */
	storeConnection(key: string, conn: SmtpConnection): void {
		// First return of a freshly-connected socket has no carried meta: seed openedAt
		// from the connection's own open time (not `Date.now()`), so the max-lifetime cap
		// measures from when the socket opened, not from its first park. A reused socket
		// carries its meta forward from `takeConnection`.
		const meta = this.connMeta.get(conn) ?? { messagesSent: 0, openedAt: conn.openedAt };
		this.connMeta.delete(conn);
		const messagesSent = meta.messagesSent + 1;

		const entry = this.pool.get(key);
		if (entry?.active === conn) entry.active = undefined;
		if (
			!entry ||
			entry.idle ||
			this.isRetirable(messagesSent, meta.openedAt, entry.maxDeliveriesPerConnection)
		) {
			this.quitConnection(conn);
			return;
		}
		entry.idle = { conn, messagesSent, openedAt: meta.openedAt };
		entry.lastUsedAt = Date.now();
		this.updateGauge();
	}

	/**
	 * Whether a socket has exhausted a reuse guardrail — the per-connection message
	 * cap, or its max lifetime (`maxAgeMs`) from its real open time — and must be
	 * retired (clean QUIT + reconnect) rather than reused. The single predicate both
	 * {@link takeConnection} and {@link storeConnection} consult, so the bounds live
	 * in one place.
	 */
	private isRetirable(
		messagesSent: number,
		openedAt: number,
		maxDeliveriesPerConnection: number
	): boolean {
		return (
			messagesSent >= maxDeliveriesPerConnection || Date.now() - openedAt > this.config.maxAgeMs
		);
	}

	/**
	 * Tear down a poisoned connection after a transport/protocol error mid-delivery
	 * and evict its whole entry, releasing the global slot. A socket that errored once
	 * is NEVER reused; the in-flight job retries on a fresh connection exactly once.
	 * Idempotent with respect to a missing entry.
	 */
	evictConnection(key: string, conn: SmtpConnection): void {
		conn.close();
		this.connMeta.delete(conn);
		const entry = this.pool.get(key);
		if (!entry) {
			return;
		}
		if (entry.active && entry.active !== conn) entry.active.close();
		entry.active = undefined;
		if (entry.idle) {
			// Defensive: a concurrently-parked socket on a now-poisoned entry goes too.
			entry.idle.conn.close();
			entry.idle = undefined;
		}
		this.pool.delete(key);
		this.cap.release(entry.globalLease);
		this.updateGauge();
		logger.debug({ key }, 'Evicted pool entry after a transport error');
	}

	/** Fence one source identity from idle and checked-out socket reuse. */
	invalidateBindIp(bindIp: string): void {
		let changed = false;
		for (const [key, entry] of this.pool.entries()) {
			if (entry.config.localAddress !== bindIp) continue;
			entry.active?.close();
			entry.idle?.conn.close();
			this.pool.delete(key);
			this.cap.release(entry.globalLease);
			changed = true;
		}
		if (changed) {
			this.updateGauge();
			logger.warn({ bindIp }, 'Invalidated SMTP pool entries for ineligible source IP');
		}
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

	/** Deterministic seam for health checks and ownership-loss tests. */
	renewDistributedLeases(): Promise<void> {
		return this.leaseHeartbeat.runNow();
	}

	private handleLeaseLoss(target: LeaseHeartbeatTarget): void {
		const entry = this.pool.get(target.key);
		if (!entry || entry.globalLease !== target.lease) return;
		entry.active?.close();
		this.disposeIdle(entry);
		this.pool.delete(target.key);
		this.cap.release(entry.globalLease);
		this.updateGauge();
		logger.error(
			{ key: target.key, connectionScope: entry.globalLease.connectionScope },
			'Lost distributed SMTP connection lease; closed the pool entry'
		);
	}

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
				this.cap.release(entry.globalLease);
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
		this.leaseHeartbeat.stop();

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
			entry.active?.close();
			this.disposeIdle(entry);
			this.cap.release(entry.globalLease);
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
	 * TTL for the global/instance counters — must outlive an entry's max age so a live
	 * connection's slot never expires out from under it. The decrement on teardown is
	 * the real cleanup; the TTL is only a crashed-instance backstop.
	 */
	private slotTtlSeconds(): number {
		return Math.ceil(this.config.maxAgeMs / 1000) + 60;
	}
}

/** Singleton pool instance */
export const pool = new SmtpConnectionPool();
