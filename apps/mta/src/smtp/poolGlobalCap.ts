/**
 * Cross-instance global connection-cap coordination for the SMTP connection pool.
 *
 * Optional (via Redis): each ACTUALLY-CREATED pool entry holds one global slot
 * (`mta:pool:global:<scope>`) counting a live socket lineage in that provider or
 * MX-host scope across ALL MTA instances. The slot is
 * reserved atomically at creation ({@link PoolGlobalCap.tryReserve}: INCR-then-
 * check, rolled back when over cap) and released on every teardown path
 * ({@link PoolGlobalCap.release}). The cap is best-effort: it fail-OPENS (no
 * throttle) when Redis is down or coordination is disabled. Split out of
 * connectionPool.ts so that file stays focused on the entry lifecycle.
 */

import type Redis from "ioredis";

export class PoolGlobalCap {
	private redis?: Redis;
	private defaultGlobalMaxConnections?: number;
	private serverId?: string;

	/**
	 * Enable coordination. When enabled, each instance registers its live sockets
	 * in Redis so the total in each connection scope stays within the cap.
	 */
	enable(redis: Redis, defaultGlobalMaxConnections: number, serverId: string): void {
		this.redis = redis;
		this.defaultGlobalMaxConnections = defaultGlobalMaxConnections;
		this.serverId = serverId;
	}

	/**
	 * The global connection count for a provider or MX-host scope. Fail-open
	 * to 0. Exposed for monitoring/tests.
	 */
	async getCount(connectionScope: string): Promise<number> {
		if (!this.redis) return 0;
		try {
			const count = await this.redis.get(`mta:pool:global:${connectionScope}`);
			return count ? parseInt(count, 10) : 0;
		} catch {
			return 0;
		}
	}

	/**
	 * Atomically reserve one global slot for a NEW entry in `connectionScope`. INCR is
	 * atomic, so concurrent reservers get distinct counts and only those within the
	 * cap keep their slot; an over-cap reserver rolls its INCR back. Returns true
	 * (allow, no tracking) when coordination is disabled, and fail-OPEN (true) on
	 * any Redis error so an outage degrades to per-instance limiting. `ttlSeconds`
	 * must outlive an entry's max age so a live connection's slot never expires out
	 * from under it — the decrement on teardown is the real cleanup, the TTL only a
	 * crashed-instance backstop.
	 */
	async tryReserve(
		connectionScope: string,
		ttlSeconds: number,
		maximum?: number,
	): Promise<boolean> {
		const limit = maximum ?? this.defaultGlobalMaxConnections;
		if (!this.redis || !this.serverId || !limit) return true;

		const globalKey = `mta:pool:global:${connectionScope}`;
		const instanceKey = `mta:pool:instance:${this.serverId}:${connectionScope}`;

		try {
			const count = await this.redis.incr(globalKey);
			await this.redis.expire(globalKey, ttlSeconds);
			if (count > limit) {
				await this.redis.decr(globalKey); // over cap — give the slot back
				return false;
			}
			await this.redis.incr(instanceKey);
			await this.redis.expire(instanceKey, ttlSeconds);
			return true;
		} catch {
			return true; // fail open
		}
	}

	/**
	 * Release one global slot held by a torn-down entry. Fire-and-forget; paired
	 * 1:1 with a successful {@link PoolGlobalCap.tryReserve}. The TTL backstops any
	 * decr that is lost (e.g. instance crash).
	 */
	release(connectionScope: string): void {
		if (!this.redis || !this.serverId) return;

		const globalKey = `mta:pool:global:${connectionScope}`;
		const instanceKey = `mta:pool:instance:${this.serverId}:${connectionScope}`;

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
