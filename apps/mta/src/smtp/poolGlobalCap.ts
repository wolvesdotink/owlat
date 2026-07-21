/** Atomic, expiring distributed connection leases for the SMTP pool. */

import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';

const RESERVE_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local expiresAt = tonumber(ARGV[2])
local maximum = tonumber(ARGV[3])
local leaseId = ARGV[4]
redis.call('ZREMRANGEBYSCORE', key, '-inf', now)
if redis.call('ZCARD', key) >= maximum then
  return 0
end
redis.call('ZADD', key, expiresAt, leaseId)
local latest = redis.call('ZREVRANGE', key, 0, 0, 'WITHSCORES')
if latest[2] then redis.call('PEXPIREAT', key, tonumber(latest[2])) end
return 1
`;

const RELEASE_SCRIPT = `
local key = KEYS[1]
local removed = redis.call('ZREM', key, ARGV[1])
if redis.call('ZCARD', key) == 0 then
  redis.call('DEL', key)
else
  local latest = redis.call('ZREVRANGE', key, 0, 0, 'WITHSCORES')
  if latest[2] then redis.call('PEXPIREAT', key, tonumber(latest[2])) end
end
return removed
`;

const COUNT_SCRIPT = `
local key = KEYS[1]
redis.call('ZREMRANGEBYSCORE', key, '-inf', tonumber(ARGV[1]))
local count = redis.call('ZCARD', key)
if count == 0 then redis.call('DEL', key) end
return count
`;

export interface GlobalConnectionLease {
	connectionScope: string;
	/** Absent when distributed coordination is disabled. */
	leaseId?: string;
}

export class PoolGlobalCap {
	private redis?: Redis;
	private defaultGlobalMaxConnections?: number;
	private serverId?: string;

	enable(redis: Redis, defaultGlobalMaxConnections: number, serverId: string): void {
		this.redis = redis;
		this.defaultGlobalMaxConnections = defaultGlobalMaxConnections;
		this.serverId = serverId;
	}

	async getCount(connectionScope: string): Promise<number> {
		if (!this.redis) return 0;
		try {
			const result = await this.redis.eval(
				COUNT_SCRIPT,
				1,
				this.leasesKey(connectionScope),
				String(Date.now())
			);
			return typeof result === 'number' ? result : Number(result) || 0;
		} catch {
			return 0;
		}
	}

	/**
	 * Atomically prune expired leases and reserve one slot. Redis errors fail
	 * closed: a lost response may have committed the lease, so admitting an
	 * untracked local entry would violate the cap. The ghost lease self-expires.
	 */
	async tryReserve(
		connectionScope: string,
		ttlSeconds: number,
		maximum?: number
	): Promise<GlobalConnectionLease | null> {
		const limit = maximum ?? this.defaultGlobalMaxConnections;
		if (!this.redis || !this.serverId || !limit) return { connectionScope };

		const leaseId = `${this.serverId}:${randomUUID()}`;
		const now = Date.now();
		try {
			const reserved = await this.redis.eval(
				RESERVE_SCRIPT,
				1,
				this.leasesKey(connectionScope),
				String(now),
				String(now + ttlSeconds * 1000),
				String(limit),
				leaseId
			);
			return Number(reserved) === 1 ? { connectionScope, leaseId } : null;
		} catch {
			return null;
		}
	}

	/** Release only the exact lease owned by this entry; duplicate release is safe. */
	release(lease: GlobalConnectionLease): void {
		if (!this.redis || !lease.leaseId) return;
		void this.redis
			.eval(RELEASE_SCRIPT, 1, this.leasesKey(lease.connectionScope), lease.leaseId)
			.catch(() => {
				// Fail closed: an unreleased lease expires without corrupting other owners.
			});
	}

	private leasesKey(connectionScope: string): string {
		return `mta:pool:leases:v1:${connectionScope}`;
	}
}
