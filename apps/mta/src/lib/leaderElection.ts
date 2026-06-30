/**
 * Redis-based Leader Election
 *
 * Ensures periodic tasks (DNSBL checking, warming evaluation) run on only
 * one MTA instance in multi-node deployments. Uses a simple Redis lock
 * with TTL-based expiry for automatic failover.
 */

import type Redis from 'ioredis';
import { logger } from '../monitoring/logger.js';

const LEADER_KEY = 'mta:leader';
const LOCK_TTL_SECONDS = 30;
const RENEW_INTERVAL_MS = 15_000;

let renewTimer: ReturnType<typeof setInterval> | undefined;
let isCurrentLeader = false;

/**
 * Start participating in leader election.
 * Attempts to acquire leadership immediately, then periodically renews.
 */
export function startLeaderElection(redis: Redis, serverId: string): void {
	const tryAcquire = async () => {
		try {
			if (isCurrentLeader) {
				// Renew existing lock
				const result = await redis.set(LEADER_KEY, serverId, 'EX', LOCK_TTL_SECONDS, 'XX');
				if (result !== 'OK') {
					// Lost leadership (lock expired or was taken)
					// Try to re-acquire
					const acquired = await redis.set(LEADER_KEY, serverId, 'EX', LOCK_TTL_SECONDS, 'NX');
					if (acquired === 'OK') {
						logger.info({ serverId }, 'Re-acquired leadership');
					} else {
						isCurrentLeader = false;
						logger.info({ serverId }, 'Lost leadership');
					}
				}
			} else {
				// Try to acquire leadership
				const result = await redis.set(LEADER_KEY, serverId, 'EX', LOCK_TTL_SECONDS, 'NX');
				if (result === 'OK') {
					isCurrentLeader = true;
					logger.info({ serverId }, 'Acquired leadership');
				}
			}
		} catch (err) {
			logger.warn({ err, serverId }, 'Leader election error');
		}
	};

	// Attempt immediately
	tryAcquire();

	// Renew periodically
	renewTimer = setInterval(tryAcquire, RENEW_INTERVAL_MS);
}

/**
 * Check if this instance is the current leader.
 * Use this to guard periodic tasks.
 */
export function isLeader(): boolean {
	return isCurrentLeader;
}

/**
 * Stop participating in leader election and release leadership.
 */
export async function stopLeaderElection(redis: Redis, serverId: string): Promise<void> {
	if (renewTimer) {
		clearInterval(renewTimer);
		renewTimer = undefined;
	}

	if (isCurrentLeader) {
		try {
			// Only delete the key if we still own it
			const currentLeader = await redis.get(LEADER_KEY);
			if (currentLeader === serverId) {
				await redis.del(LEADER_KEY);
			}
		} catch {
			// Best-effort cleanup
		}
		isCurrentLeader = false;
	}
}
