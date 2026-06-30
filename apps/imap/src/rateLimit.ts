/**
 * Authentication rate limiter for the IMAP LOGIN path.
 *
 * Two sliding-window counters (sorted-set under Redis):
 *   - `imap:lim:ip:<ip>` — bound on global noise from one IP.
 *   - `imap:lim:auth:<ip>:<addr>` — bound on per-credential brute-force.
 *
 * When either window is over budget the caller sleeps for at most
 * `tarpitMs` (capped at 5 s by the caller to keep file descriptors free)
 * before returning the credential-failed response. Redis remembers the
 * full window so the next reconnect from the same address-IP tuple is
 * still throttled.
 *
 * Failure mode: Redis unreachable → fail-open (warn-log + skip), so a
 * misconfigured Redis cannot lock everyone out of their mail.
 */

import type Redis from 'ioredis';
import { logger } from './logger.js';

export interface RateLimitConfig {
	/** Per-(ip,address) failure budget per windowMs. */
	failuresPerWindow: number;
	windowMs: number;
	/** Tarpit duration once over budget (caller may further cap). */
	tarpitMs: number;
}

const PER_IP_FAILURE_LIMIT = 50;

export interface CheckResult {
	throttled: boolean;
	tarpitMs: number;
	ipCount: number;
	authCount: number;
}

export class AuthRateLimiter {
	constructor(
		private redis: Redis | null,
		private config: RateLimitConfig
	) {}

	private ipKey(ip: string): string {
		return `imap:lim:ip:${ip}`;
	}

	private authKey(ip: string, address: string): string {
		return `imap:lim:auth:${ip}:${address.toLowerCase()}`;
	}

	/**
	 * Count current failures inside the window. Does NOT increment —
	 * callers run this before LOGIN to decide whether to tarpit, and
	 * separately call `recordFailure` on the failure branch.
	 */
	async check(ip: string, address: string): Promise<CheckResult> {
		if (!this.redis) {
			return { throttled: false, tarpitMs: 0, ipCount: 0, authCount: 0 };
		}
		const now = Date.now();
		const cutoff = now - this.config.windowMs;
		try {
			const pipeline = this.redis.pipeline();
			pipeline.zremrangebyscore(this.ipKey(ip), 0, cutoff);
			pipeline.zcard(this.ipKey(ip));
			pipeline.zremrangebyscore(this.authKey(ip, address), 0, cutoff);
			pipeline.zcard(this.authKey(ip, address));
			const results = await pipeline.exec();
			if (!results) {
				return { throttled: false, tarpitMs: 0, ipCount: 0, authCount: 0 };
			}
			const ipCount = (results[1]?.[1] as number) ?? 0;
			const authCount = (results[3]?.[1] as number) ?? 0;
			const throttled =
				authCount >= this.config.failuresPerWindow ||
				ipCount >= PER_IP_FAILURE_LIMIT;
			return {
				throttled,
				tarpitMs: throttled ? this.config.tarpitMs : 0,
				ipCount,
				authCount,
			};
		} catch (err) {
			logger.warn({ err, ip }, 'auth rate-limit check failed — failing open');
			return { throttled: false, tarpitMs: 0, ipCount: 0, authCount: 0 };
		}
	}

	/**
	 * Record a failed LOGIN. Called AFTER the credential check fails so
	 * a successful login doesn't accidentally accrue a failure.
	 */
	async recordFailure(ip: string, address: string): Promise<void> {
		if (!this.redis) return;
		const now = Date.now();
		// Set TTL slightly longer than the window so stale entries get GC'd
		// even if `check` doesn't run for that key for a while.
		const ttlSec = Math.ceil(this.config.windowMs / 1000) + 60;
		try {
			const pipeline = this.redis.pipeline();
			// Use `now + random` member names so concurrent failures don't
			// collide on the same score+member pair (zset dedupes).
			const member = `${now}-${Math.random().toString(36).slice(2, 10)}`;
			pipeline.zadd(this.ipKey(ip), now, member);
			pipeline.expire(this.ipKey(ip), ttlSec);
			pipeline.zadd(this.authKey(ip, address), now, member);
			pipeline.expire(this.authKey(ip, address), ttlSec);
			await pipeline.exec();
		} catch (err) {
			logger.warn({ err, ip }, 'auth rate-limit record failed — failing open');
		}
	}
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
