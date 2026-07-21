/** Distributed SMTP connection admission with a rolling-upgrade protocol gate. */

import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';

export type PoolCoordinationProtocol = 'legacy-v0' | 'leases-v1';

const REDIS_NOW_MS = `
local redisTime = redis.call('TIME')
local now = redisTime[1] * 1000 + math.floor(redisTime[2] / 1000)
`;

const RESERVE_LEASE_SCRIPT = `
local key = KEYS[1]
${REDIS_NOW_MS}
local expiresAt = now + tonumber(ARGV[1])
local maximum = tonumber(ARGV[2])
local leaseId = ARGV[3]
redis.call('ZREMRANGEBYSCORE', key, '-inf', now)
if redis.call('ZCARD', key) >= maximum then
  return 0
end
redis.call('ZADD', key, expiresAt, leaseId)
local latest = redis.call('ZREVRANGE', key, 0, 0, 'WITHSCORES')
if latest[2] then redis.call('PEXPIREAT', key, tonumber(latest[2])) end
return 1
`;

const RENEW_LEASE_SCRIPT = `
local key = KEYS[1]
${REDIS_NOW_MS}
local leaseId = ARGV[2]
local existingExpiry = redis.call('ZSCORE', key, leaseId)
if not existingExpiry or tonumber(existingExpiry) <= now then
  redis.call('ZREM', key, leaseId)
  return 0
end
redis.call('ZADD', key, now + tonumber(ARGV[1]), leaseId)
local latest = redis.call('ZREVRANGE', key, 0, 0, 'WITHSCORES')
if latest[2] then redis.call('PEXPIREAT', key, tonumber(latest[2])) end
return 1
`;

const RELEASE_LEASE_SCRIPT = `
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

const COUNT_LEASES_SCRIPT = `
local key = KEYS[1]
${REDIS_NOW_MS}
redis.call('ZREMRANGEBYSCORE', key, '-inf', now)
local count = redis.call('ZCARD', key)
if count == 0 then redis.call('DEL', key) end
return count
`;

// This protocol intentionally matches main's scalar keys and operations. New
// binaries remain on it during a rolling software upgrade. Only after every old
// process is drained may the fleet switch together to leases-v1.
const RESERVE_LEGACY_SCRIPT = `
local globalKey = KEYS[1]
local instanceKey = KEYS[2]
local count = redis.call('INCR', globalKey)
redis.call('EXPIRE', globalKey, tonumber(ARGV[1]))
if count > tonumber(ARGV[2]) then
  local rolledBack = redis.call('DECR', globalKey)
  if rolledBack <= 0 then redis.call('DEL', globalKey) end
  return 0
end
redis.call('INCR', instanceKey)
redis.call('EXPIRE', instanceKey, tonumber(ARGV[1]))
return 1
`;

const RELEASE_LEGACY_SCRIPT = `
local globalKey = KEYS[1]
local instanceKey = KEYS[2]
local instanceCount = tonumber(redis.call('GET', instanceKey) or '0')
if instanceCount <= 0 then return 0 end
instanceCount = redis.call('DECR', instanceKey)
if instanceCount <= 0 then redis.call('DEL', instanceKey) end
local globalCount = tonumber(redis.call('GET', globalKey) or '0')
if globalCount > 0 then
  globalCount = redis.call('DECR', globalKey)
  if globalCount <= 0 then redis.call('DEL', globalKey) end
end
return 1
`;

export interface GlobalConnectionLease {
	connectionScope: string;
	protocol: PoolCoordinationProtocol | 'disabled';
	/** Unique local ownership token; stored in Redis by leases-v1. */
	leaseId?: string;
}

/** Refuse the leases-v1 cutover while any main-version scalar owner may remain. */
export async function assertLeaseProtocolCutoverSafe(redis: Redis): Promise<void> {
	let cursor = '0';
	do {
		const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', 'mta:pool:global:*', 'COUNT', 100);
		if (keys.length > 0) {
			throw new Error(
				`Cannot enable leases-v1 while legacy pool counters remain (${keys[0]}). ` +
					'Drain every old MTA and wait for legacy keys to expire.'
			);
		}
		cursor = nextCursor;
	} while (cursor !== '0');
}

export class PoolGlobalCap {
	private redis?: Redis;
	private defaultGlobalMaxConnections?: number;
	private serverId?: string;
	private protocol: PoolCoordinationProtocol = 'leases-v1';
	private ownedLeaseIds = new Set<string>();

	enable(
		redis: Redis,
		defaultGlobalMaxConnections: number,
		serverId: string,
		protocol: PoolCoordinationProtocol = 'leases-v1'
	): void {
		this.redis = redis;
		this.defaultGlobalMaxConnections = defaultGlobalMaxConnections;
		this.serverId = serverId;
		this.protocol = protocol;
	}

	async getCount(connectionScope: string): Promise<number> {
		if (!this.redis) return 0;
		try {
			if (this.protocol === 'legacy-v0') {
				const count = await this.redis.get(this.legacyGlobalKey(connectionScope));
				return count ? Number(count) || 0 : 0;
			}
			const result = await this.redis.eval(COUNT_LEASES_SCRIPT, 1, this.leasesKey(connectionScope));
			return typeof result === 'number' ? result : Number(result) || 0;
		} catch {
			return 0;
		}
	}

	async tryReserve(
		connectionScope: string,
		ttlSeconds: number,
		maximum?: number
	): Promise<GlobalConnectionLease | null> {
		const limit = maximum ?? this.defaultGlobalMaxConnections;
		if (!this.redis || !this.serverId || !limit) {
			return { connectionScope, protocol: 'disabled' };
		}

		const leaseId = `${this.serverId}:${randomUUID()}`;
		try {
			const reserved =
				this.protocol === 'legacy-v0'
					? await this.redis.eval(
							RESERVE_LEGACY_SCRIPT,
							2,
							this.legacyGlobalKey(connectionScope),
							this.legacyInstanceKey(connectionScope),
							String(ttlSeconds),
							String(limit)
						)
					: await this.redis.eval(
							RESERVE_LEASE_SCRIPT,
							1,
							this.leasesKey(connectionScope),
							String(ttlSeconds * 1000),
							String(limit),
							leaseId
						);
			if (Number(reserved) !== 1) return null;
			this.ownedLeaseIds.add(leaseId);
			return { connectionScope, protocol: this.protocol, leaseId };
		} catch {
			return null;
		}
	}

	/** Extend an exact owned lease using Redis's clock, never a process clock. */
	async renew(lease: GlobalConnectionLease, ttlSeconds: number): Promise<boolean> {
		if (lease.protocol === 'disabled') return true;
		if (lease.protocol === 'legacy-v0') return this.ownedLeaseIds.has(lease.leaseId ?? '');
		if (!this.redis || !lease.leaseId || !this.ownedLeaseIds.has(lease.leaseId)) return false;
		try {
			const renewed = await this.redis.eval(
				RENEW_LEASE_SCRIPT,
				1,
				this.leasesKey(lease.connectionScope),
				String(ttlSeconds * 1000),
				lease.leaseId
			);
			return Number(renewed) === 1;
		} catch {
			return false;
		}
	}

	/** Release only an owned reservation; repeated local release is a no-op. */
	release(lease: GlobalConnectionLease): void {
		if (!this.redis || !lease.leaseId || !this.ownedLeaseIds.delete(lease.leaseId)) return;
		const operation =
			lease.protocol === 'legacy-v0'
				? this.redis.eval(
						RELEASE_LEGACY_SCRIPT,
						2,
						this.legacyGlobalKey(lease.connectionScope),
						this.legacyInstanceKey(lease.connectionScope)
					)
				: this.redis.eval(
						RELEASE_LEASE_SCRIPT,
						1,
						this.leasesKey(lease.connectionScope),
						lease.leaseId
					);
		void operation.catch(() => {
			// Fail closed: an unreleased reservation expires after process loss.
		});
	}

	private leasesKey(connectionScope: string): string {
		return `mta:pool:leases:v1:${connectionScope}`;
	}

	private legacyGlobalKey(connectionScope: string): string {
		return `mta:pool:global:${connectionScope}`;
	}

	private legacyInstanceKey(connectionScope: string): string {
		return `mta:pool:instance:${this.serverId}:${connectionScope}`;
	}
}
